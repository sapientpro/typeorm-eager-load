import type { Connection, DataSource, EntityManager, SelectQueryBuilder } from "typeorm";
import type { ColumnMetadata } from "typeorm/metadata/ColumnMetadata";
import type { RelationMetadata } from "typeorm/metadata/RelationMetadata";
import type {
  EagerContext,
  EagerLoadClosure,
  LateralCallback,
  RelationDefinitions,
  RelationObjectDefinition
} from "./types";

let eagerDataSource: DataSource | Connection;
type ParsedRelations = {
  [key: string]: {
    closure?: EagerLoadClosure | undefined,
    relations: RelationObjectDefinition
    relation: string
    modifier?: string
  }
}

export function setEagerDataSource(dataSource: DataSource | Connection) {
  eagerDataSource = dataSource;
}

function flatRelations(relations: RelationDefinitions): RelationDefinitions {
  if (typeof relations === 'string') {
    return {[relations]: undefined};
  }
  if (Array.isArray(relations)) {
    return relations.reduce((relations, item) => Object.assign(relations, flatRelations(item)), {});
  }
  return relations;
}

function parseRelations(relations: RelationDefinitions): ParsedRelations {
  return Object.entries(flatRelations(relations)).reduce((relations, [relationDefinition, callback]) => {
    const {
      relation,
      alias = relation as string,
      other,
      modifier
    }: { relation?: string, alias?: string, other?: string, modifier?: string }
      = relationDefinition.match(/^(?:(?<alias>[^:.]+):)?(?<relation>[^.:]+?)(?<modifier>[-+#])?(?:\.(?<other>.*))?$/)?.groups || {};
    if (!relation) {
      throw new Error(`Invalid relation definition: ${relationDefinition}`);
    }
    relations[alias] = relations[alias] || {relations: {}, relation};
    if (modifier) {
      relations[alias].modifier = modifier;
    }
    if (other) {
      relations[alias].relations[other] = callback;
    } else {
      callback && (relations[alias].closure = callback);
    }

    return relations;
  }, {} as ParsedRelations);
}

function groupBy<T extends { [key: string]: any }>(entities: T[], field: string | ((entity: T) => any)) {
  const groups: { [key: string]: T[] } = {};
  entities.forEach((entity) => {
    const value = field instanceof Function ? field(entity) : entity[field];
    (Array.isArray(value) ? value : [value]).forEach((value) => {
      groups.hasOwnProperty(value) ? groups[value].push(entity) : groups[value] = [entity];
    });
  });
  return groups;
}

export async function eagerLoad<Entity extends { [key: string]: any }>(entities: Entity[] | Entity | undefined | null, relations: RelationDefinitions, entityManager?: EntityManager, entity?: any) {
  if (!entities) return;

  entities = Array.isArray(entities) ? entities : [entities];
  if (entities.length === 0) return;

  const model = entity ?? entities[0].constructor;

  const meta = eagerDataSource.getMetadata(model);

  await Promise.all(Object.entries(parseRelations(relations)).map(async ([alias, {
    closure,
    relations,
    relation: relationName,
    modifier
  }]) => {
    const relation = meta.findRelationWithPropertyPath(relationName);

    if (!relation) {
      throw new Error(`Relation ${alias !== relationName ? `${alias}:` : ''}${relationName} for ${model.name} not found`);
    }

    //skip loading if relation is already loaded
    if (modifier && ['+', '-'].includes(modifier) && !closure) {
      await eagerLoad(entities?.map((entity: Entity) => entity[alias]).filter((entity: any) => entity).flat(), relations);
      return;
    }

    const manager = entityManager ?? eagerDataSource.createEntityManager(),
      repository = manager.getRepository<Entity>(relation.type);

    const
      multi = relation.isOneToMany || relation.isManyToMany,
      builder = repository.createQueryBuilder(relationName);
    let targetRelation = relation, inverse = false;
    let referenceName: string | void;
    let where = (builder: SelectQueryBuilder<any>, closure: EagerLoadClosure, context: EagerContext) => (
      closure(builder, context), `${builder.alias}.${columnName}`
    );
    let groupClosure: any;

    switch (relation.relationType) {
      case 'many-to-one':
        break;

      case 'one-to-many':
        targetRelation = <typeof relation>targetRelation.inverseRelation;
        inverse = true;
        break;

      case 'one-to-one':
        if (!relation.isOneToOneOwner) {
          inverse = true;
          targetRelation = <typeof relation>targetRelation.inverseRelation;
        }
        break;
      case 'many-to-many': {
        inverse = true;
        referenceName = (relation.inverseJoinColumns[0].referencedColumn as ColumnMetadata).propertyName;
        const relatedName = relation.joinColumns[0].databaseName;
        where = (builder: SelectQueryBuilder<Entity>, closure: EagerLoadClosure, context: EagerContext) => (closure(builder.innerJoinAndMapMany(
            `${relationName}.junction`, relation.joinTableName, 'junction',
            `junction.${relation.inverseJoinColumns[0].databaseName} = ${relationName}.${referenceName}`,
          ), context), `junction.${relatedName}`
        );
        groupClosure = (entity: { junction?: Record<string, any>[] }) => {
          const values = entity.junction!.map(entity => entity[relatedName]);
          delete entity.junction;
          return values;
        };
        break;
      }
      default:
        throw new Error(`Relation ${relation?.relationType} not implemented yet`);
    }
    const
      joinColumn = targetRelation.joinColumns[0],
      referencedColumn = <typeof joinColumn>joinColumn.referencedColumn,
      [referencedColumnName, columnName] = inverse ? [referencedColumn.propertyName, joinColumn.propertyName] : [joinColumn.propertyName, referencedColumn.propertyName];

    const additionalRelations: RelationDefinitions[] = [relations];
    let filteredEntities = (entities as Entity[]);
    let lateral: LateralCallback | undefined;
    let lateralAlias: string;
    const field = where(builder, closure || (() => void 0), {
      loadWith: (loadWith: RelationDefinitions) => {
        additionalRelations.push(loadWith);
      },
      filter: (callback) => {
        filteredEntities = filteredEntities.filter(callback);
      },
      lateral: (callback, alias = 'outerLateral') => {
        lateral = callback;
        lateralAlias = alias;
      },
    });

    const entityIds = filteredEntities.reduce((set, entity) => set.add(entity[referencedColumnName]), new Set<number | string | null | undefined>());

    if (lateral) {
      const aliases = [...builder.expressionMap.aliases],
        outerAlias = builder.expressionMap.createAlias({
          name: lateralAlias!,
          type: 'from',
          target: meta.target,
          tablePath: meta.tablePath,
        });
      builder.expressionMap.aliases = [outerAlias, ...aliases];
      builder.andWhere(`${outerAlias.name}.${referencedColumn.databaseName} IN (:...entityIds)`, {entityIds: [...entityIds]});

      const preLateralBuilder = repository.createQueryBuilder(relationName)
        .select('*');

      const lateralBuilder = lateral(preLateralBuilder, outerAlias.name) ?? preLateralBuilder;
      lateralBuilder.expressionMap.createAlias({
        name: outerAlias.name,
        type: 'from',
        target: meta.target,
      });
      lateralBuilder.andWhere(`${field} = ${outerAlias.name}.${referencedColumn.databaseName}`);

      if (Object.keys(lateralBuilder.expressionMap.allOrderBys).length !== 0 && lateralBuilder.expressionMap.limit !== 1) {
        //store the order bys in a subquery
        lateralBuilder.addSelect('ROW_NUMBER() OVER ()', 'lateral_ordering');
        builder.addOrderBy('lateral_ordering', 'ASC');
      }

      builder.expressionMap.mainAlias!.subQuery = 'LATERAL(' + lateralBuilder.getQuery() + ')';
      builder.setParameters(lateralBuilder.getParameters());

    } else {
      builder.andWhere(`${field} IN (:...entityIds)`, {entityIds: [...entityIds]});
    }

    const checkJoinedRelations = (relation: RelationMetadata, alias: string, relations: RelationDefinitions[]) => {
      const
        meta = eagerDataSource.getMetadata(relation.type),
        parsedRelations = parseRelations(relations);

      meta.relations.forEach((relation) => {
        if (relation.isEager && !(relation.propertyName in parsedRelations)) {
          relations.unshift(`${relation.propertyName}+`);
        }
      });

      Object.entries(parseRelations(relations)).forEach(([relationAlias, {
        relation: relationName,
        relations,
        modifier
      }]) => {
        if (modifier === '+') {
          const relation = meta.findRelationWithPropertyPath(relationName)!;
          relation.relationType.endsWith('to-many')
            ? builder.leftJoinAndMapMany(alias + '.' + relationAlias, alias + '.' + relationName, alias + '_' + relationAlias)
            : builder.leftJoinAndMapOne(alias + '.' + relationAlias, alias + '.' + relationName, alias + '_' + relationAlias);
          checkJoinedRelations(meta.findRelationWithPropertyPath(relationName)!, alias + '_' + relationAlias, [relations]);
        }
      });
    };

    checkJoinedRelations(relation, relationName, additionalRelations);

    entityIds.delete(null);
    entityIds.delete(undefined);
    const models = entityIds.size ? await builder.getMany() : [];
    const dictionary = groupBy(models, groupClosure ?? columnName);

    filteredEntities.forEach((entity) => {
      const models = dictionary[entity[referencedColumnName]] || [];
      Object.assign(entity, {[alias]: multi ? models : models[0] || null});
    });
    await eagerLoad(models, additionalRelations, entityManager);

    return entities;
  }));
}