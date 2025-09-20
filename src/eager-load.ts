export * from './types';
import type { EntityManager, SelectQueryBuilder } from 'typeorm';
import type { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';
import type { RelationMetadata } from 'typeorm/metadata/RelationMetadata';
import { getEagerDataSource } from "./current-data-source";
import { extractIds } from "./extract-ids";
import { groupBy } from "./group-by";
import { parseRelations } from "./parse-relations";
import type { EagerContext, EagerLoadClosure, LateralCallback, RelationDefinitions, } from './types';

export async function eagerLoad<Entity extends {
  [key: string]: any
}>(entities: Entity[] | Entity | undefined | null, relations: RelationDefinitions, entityManager: EntityManager = getEagerDataSource().createEntityManager(), entity?: any) {
  if (!entities?.length) return;

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
          return relation.joinColumns.map(({ databaseName }) => `junctions.${databaseName}`);
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
      additionalModels: (models: any[]) => {
        additonalModels = models.flatMap((model) => {
          if (!(model instanceof <Function>targetRelation.target)) {
            throw Error('Invalid model. Must be instance of ' + targetRelation.entityMetadata.name);
          }
          return model;
        })
      }
    });

    let entityIds: Array<any[]>

    if (lateral) {
      const columnNames = meta.primaryColumns.map(({ propertyName }) => propertyName);
      entityIds = extractIds(filteredEntities, columnNames);
      const aliases = [...builder.expressionMap.aliases],
        outerAlias = builder.expressionMap.createAlias({
          name: lateralAlias!,
          type: 'from',
          target: meta.target,
          tablePath: meta.tablePath,
        });
      builder.expressionMap.aliases = [outerAlias, ...aliases];

      const params: Record<string, any> = {};
      builder.andWhere(`(${columnNames.map(columnName => `${outerAlias.name}.${columnName}`).join(', ')}) IN (${entityIds.map((ids, idx1) => `(${ids.map((id, idx2) => {
        const paramName = `eager_param_${idx1}_${idx2}`
        params[paramName] = id;
        return `:${paramName}`;
      }).join(',')})`).join(',')})`, params);

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
      const params: Record<string, any> = {}
      builder.andWhere(`(${fields.join(', ')}) IN (${entityIds.map((ids, idx1) => `(${ids.map((id, idx2) => {
        const paramName = `eager_param_${idx1}_${idx2}`
        params[paramName] = id;
        return `:${paramName}`;
      }).join(',')})`).join(',')})`, params);
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
      Object.assign(entity, { [alias]: multi ? models : (models as unknown as any[])[0] || null });
    });

    await eagerLoad(models.concat(additonalModels), additionalRelations, entityManager, relation.type);

    return entities;
  }));
}
