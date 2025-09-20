import type { ParsedRelations, RelationDefinitions } from "./types";
import { flatRelations } from "./flat-relation";

export function parseRelations(relations: RelationDefinitions): ParsedRelations {
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