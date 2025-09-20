import { type SelectQueryBuilder } from "typeorm";

export type LateralCallback = (builder: SelectQueryBuilder<any>, outerAlias: string) => SelectQueryBuilder<any> | void;

export type EagerContext = {
  loadWith: (relations: RelationDefinitions) => unknown;
  filter: (callback: ((entity: any) => any)) => unknown;
  lateral: (callback: LateralCallback, alias?: string) => void;
  loadRaw: (multi?: boolean) => void;
  additionalModels: (models: any[]) => void;
}
export type EagerLoadClosure<Args extends any[] = []> = (builder: SelectQueryBuilder<any>, context: EagerContext, ...args: Args) => void;

export type RelationObjectDefinition<Args extends any[] = []> = { [key: string]: EagerLoadClosure<Args> | undefined };

export type RelationDefinitions<Args extends any[] = []> =
  string
  | (string | RelationDefinitions<Args>)[]
  | RelationObjectDefinition<Args>;

export type ParsedRelations = {
  [key: string]: {
    closure?: EagerLoadClosure | undefined,
    relations: RelationObjectDefinition
    relation: string
    modifier?: string
  }
}