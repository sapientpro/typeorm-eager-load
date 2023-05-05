import { type SelectQueryBuilder } from "typeorm";

export type LateralCallback = (builder: SelectQueryBuilder<any>, outerAlias: string) => SelectQueryBuilder<any> | void;
export type EagerContext = {
  loadWith: (relations: RelationDefinitions) => unknown;
  filter: (callback: ((entity: any) => any)) => unknown;
  lateral: (callback: LateralCallback, alias?: string) => void;
}
export type EagerLoadClosure<Args extends any[] = []> = (builder: SelectQueryBuilder<any>, context: EagerContext, ...args: Args) => void;
export type RelationObjectDefinition<Args extends any[] = []> = { [key: string]: EagerLoadClosure<Args> | undefined };
export type RelationDefinitions<Args extends any[] = []> =
  string
  | (string | RelationDefinitions<Args>)[]
  | RelationObjectDefinition<Args>;