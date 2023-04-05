import { type SelectQueryBuilder } from "typeorm";

export type LateralCallback = (builder: SelectQueryBuilder<any>, outerAlias: string) => SelectQueryBuilder<any> | void;
export type EagerContext = {
  loadWith: (relations: RelationDefinitions) => unknown;
  filter: (callback: ((entity: any) => any)) => unknown;
  lateral: (callback: LateralCallback, alias?: string) => void;
}
export type EagerLoadClosure = (builder: SelectQueryBuilder<any>, context: EagerContext) => void;
export type RelationObjectDefinition = { [key: string]: EagerLoadClosure | undefined };
export type RelationDefinitions = string | (string | RelationDefinitions)[] | RelationObjectDefinition;