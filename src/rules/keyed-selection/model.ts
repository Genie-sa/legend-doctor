import type ts from "typescript";

export const LIST_SIZED_OWNER_JSX_ELEMENTS = 12;

export const MAX_CONSUMER_JSX_SHARE = 0.4;

export interface ArraySetAlias {
  declaration: ts.VariableDeclaration;
  stateSource: ts.Identifier;
}

export interface KeyedRecordEntry {
  path: readonly string[];
  repeated: ts.CallExpression;
}
