export * from './types';
import type { Connection, DataSource, EntityManager, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import type { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';
import type { RelationMetadata } from 'typeorm/metadata/RelationMetadata';
import type {
  EagerContext,
  EagerLoadClosure,
  LateralCallback,
  RelationDefinitions,
  RelationObjectDefinition,
} from './types';

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

export function flatRelations<Args extends any[] = []>(relations: RelationDefinitions<Args>): RelationObjectDefinition<Args> {
  if (typeof relations === 'string') {
    return {[relations]: undefined};
  }
  if (Array.isArray(relations)) {
    return relations.reduce((relations: RelationObjectDefinition<Args>, item: RelationDefinitions<Args>) => Object.assign(relations, flatRelations(item)), {});
  }
  return relations;
}

function parseRelations(relations: RelationDefinitions): ParsedRelations {
  return Object.entries(flatRelations(relations)).reduce((relations, [relationDefinition, callback]) => {
    const {
      relation,
      alias = relation as string,
      other,
      modifier,
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

function groupBy<T extends { [key: string]: any }>(entities: T[], fields: string[], isJunction = false): Map<any, any> {
  const groups = new Map<any, any>();

  function setEntity(obj: Record<string, any>, entity: T) {
    const m = fields.reduce((m, field, index) => {
      if (!m) return;
      const value = obj[field];
      if (value === undefined || value === null) return;
      if (!m.has(value)) {
        let newMap = index == fields.length - 1 ? <Array<T>>[] : new Map<any, any>();
        m.set(value, newMap);
        return newMap;
      }
      return m.get(value);
    }, groups) as unknown as Array<T>;

    if (m) m.push(entity);
  }

  entities.forEach((entity) => {
    if (isJunction) {
      entity.junctions.forEach((obj: any) => {
        setEntity(obj, entity);
      });
      delete entity.junctions;
    } else {
      setEntity(entity, entity);
    }
  });
  return groups;
}

function extractIds<Entity extends ObjectLiteral>(entities: Entity[], columnNames: string[]) {
  const entityIds: Array<any[]> = [];
  const map = new Map<any, any>();
  entities.forEach((entity) => {
    let m = map;
    const id = [];
    let add = false;
    for (let columnName of columnNames) {
      const value = entity[columnName];
      if (value === undefined || value === null) return;
      id.push(value);
      if (m.has(value)) {
        m = m.get(value);
      } else {
        add = true;
        const newMap = new Map<any, any>();
        m.set(value, newMap);
        m = newMap;
      }
    }
    if (add) {
      entityIds.push(id);
    }
  });

  return entityIds;
}

export async function eagerLoad<Entity extends {
  [key: string]: any
}>(entities: Entity[] | Entity | undefined | null, relations: RelationDefinitions, entityManager: EntityManager = eagerDataSource.createEntityManager(), entity?: any) {
  if (!entities) return;

  entities = Array.isArray(entities) ? entities : [entities];
  if (entities.length === 0) return;

  const model = entity ?? entities[0].constructor;

  const meta = entityManager.connection.getMetadata(model);

  await Promise.all(Object.entries(parseRelations(relations)).map(async ([alias, {
    closure,
    relations,
    relation: relationName,
    modifier,
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

    const repository = entityManager.getRepository<Entity>(relation.type);

    let multi = relation.isOneToMany || relation.isManyToMany;
    const
      builder = repository.createQueryBuilder(relationName);
    let targetRelation = relation, inverse = false;
    let where = (builder: SelectQueryBuilder<any>, closure: EagerLoadClosure, context: EagerContext) => {
      closure(builder, context);
      return columnNames.map(columnName => `${builder.alias}.${columnName}`)
    };

    let isJunction = false;

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
        isJunction = true;
        inverse = true;
        where = (builder: SelectQueryBuilder<Entity>, closure: EagerLoadClosure, context: EagerContext) => {
          const condition = relation.inverseJoinColumns.map((a) => `junctions.${a.databaseName} = ${relationName}.${(a.referencedColumn as ColumnMetadata).propertyName}`).join(' AND ');
          closure(
            builder.innerJoinAndMapMany(`${relationName}.junctions`, relation.joinTableName, 'junctions', condition),
            context,
          );
          const j = builder.expressionMap.aliases[builder.expressionMap.aliases.length - 1];
          j.metadata.columns.forEach((a) => a.isVirtual = false);
          return relation.joinColumns.map(({databaseName}) => `junctions.${databaseName}`);
        };
        break;
      }
      default:
        throw new Error(`Relation ${relation?.relationType} not implemented yet`);
    }
    const referencedColumnNames: string[] = [];
    const columnNames: string[] = [];
    targetRelation.joinColumns.forEach((joinColumn) => {
      const referencedColumn = <typeof joinColumn>joinColumn.referencedColumn;
      if (inverse) {
        referencedColumnNames.push(referencedColumn.propertyName);
        columnNames.push(joinColumn.propertyName);
      } else {
        referencedColumnNames.push(joinColumn.propertyName);
        columnNames.push(referencedColumn.propertyName);
      }
    });

    const additionalRelations: RelationDefinitions[] = [relations];
    let filteredEntities = (entities as Entity[]);
    let lateral: LateralCallback | undefined;
    // @ts-ignore
    let lateralAlias: string;
    let raw: boolean = false;
    let additonalModels: any[] = [];
    const fields = where(builder, closure || (() => void 0), {
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
      loadRaw: (newMulti?: boolean) => {
        multi = newMulti ?? multi;
        raw = true;
      },
      additionalModels: (models: any[]) => {additonalModels = models.flatMap((model) => {
        if (!(model instanceof <Function>targetRelation.target)) {
          throw Error('Invalid model. Must be instance of ' + targetRelation.entityMetadata.name);
        }
        return model;
      })}
    });

    let entityIds: Array<any[]>

    if (lateral) {
      const columnNames = meta.primaryColumns.map(({propertyName}) => propertyName);
      entityIds = extractIds(filteredEntities, columnNames);
      const aliases = [...builder.expressionMap.aliases],
        outerAlias = builder.expressionMap.createAlias({
          name: lateralAlias!,
          type: 'from',
          target: meta.target,
          tablePath: meta.tablePath,
        });
      builder.expressionMap.aliases = [outerAlias, ...aliases];

      builder.andWhere(`(${columnNames.map(columnName => `${outerAlias.name}.${columnName}`).join(', ')}) IN (${entityIds.map(ids => `(${ids.join(',')})`).join(',')})`);

      const preLateralBuilder = repository.createQueryBuilder(relationName)
        .select(`${relationName}.*`);

      preLateralBuilder.expressionMap.createAlias({
        name: outerAlias.name,
        type: 'from',
        target: meta.target,
      });

      const lateralBuilder = lateral(preLateralBuilder, outerAlias.name) ?? preLateralBuilder;

      if (preLateralBuilder !== lateralBuilder) {
        lateralBuilder.expressionMap.createAlias({
          name: outerAlias.name,
          type: 'from',
          target: meta.target,
        });
      }
      referencedColumnNames.forEach((columnName, index) => {
        lateralBuilder.andWhere(`${fields[index]} = ${outerAlias.name}.${columnName}`);
      });

      if (Object.keys(lateralBuilder.expressionMap.allOrderBys).length !== 0 && lateralBuilder.expressionMap.limit !== 1) {
        //store the order bys in a subquery
        lateralBuilder.addSelect('ROW_NUMBER() OVER ()', 'lateral_ordering');
        builder.addOrderBy('lateral_ordering', 'ASC');
      }

      builder.expressionMap.mainAlias!.subQuery = 'LATERAL(' + lateralBuilder.getQuery() + ')';
      builder.setParameters(lateralBuilder.getParameters());

    } else {
      entityIds = extractIds(filteredEntities, referencedColumnNames);
      builder.andWhere(`(${fields.join(', ')}) IN (${entityIds.map(ids => `(${ids.join(',')})`).join(',')})`);
    }

    const checkJoinedRelations = (relation: RelationMetadata, alias: string, relations: RelationDefinitions[]) => {
      const
        meta = entityManager.connection.getMetadata(relation.type),
        parsedRelations = parseRelations(relations);

      meta.relations.forEach((relation) => {
        if (relation.isEager && !(relation.propertyName in parsedRelations)) {
          relations.unshift(`${relation.propertyName}+`);
        }
      });

      Object.entries(parseRelations(relations)).forEach(([relationAlias, {
        relation: relationName,
        relations,
        modifier,
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

    const models = entityIds.length
      ? await (raw ? builder.getRawMany() : builder.getMany())
      : [];

    const dictionary = groupBy(models, columnNames, isJunction);

    filteredEntities.forEach((entity) => {
      const models = referencedColumnNames.reduce((m, columnName) => m && m.get(entity[columnName]), dictionary) ?? [];
      Object.assign(entity, {[alias]: multi ? models : (models as unknown as any[])[0] || null});
    });

    await eagerLoad(models.concat(additonalModels), additionalRelations, entityManager, relation.type);

    return entities;
  }));
}
