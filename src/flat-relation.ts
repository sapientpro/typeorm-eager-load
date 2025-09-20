import type { RelationDefinitions, RelationObjectDefinition } from "./types";

export function flatRelations<Args extends any[] = []>(relations: RelationDefinitions<Args>): RelationObjectDefinition<Args> {
  if (typeof relations === 'string') {
    return {[relations]: undefined};
  }
  if (Array.isArray(relations)) {
    return relations.reduce((relations: RelationObjectDefinition<Args>, item: RelationDefinitions<Args>) => Object.assign(relations, flatRelations(item)), {});
  }
  return relations;
}