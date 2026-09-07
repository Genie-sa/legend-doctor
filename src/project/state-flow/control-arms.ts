import type { ControlArm } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isShortCircuitBinary } from "./constant-conditions.js";
import ts from "typescript";

export function controlArms(node: ts.Node, boundary: RuntimeFunctionLike): ControlArm[] {
  const result: ControlArm[] = [];
  for (
    let current: ts.Node = node;
    current.parent && current !== boundary;
    current = current.parent
  ) {
    result.push(...armsFor(current));
  }
  return result;
}

function armsFor(current: ts.Node): ControlArm[] {
  const { parent } = current;
  if (ts.isIfStatement(parent)) {
    return ifArms(current, parent);
  }
  if (ts.isConditionalExpression(parent)) {
    return conditionalArms(current, parent);
  }
  if (isShortCircuitBinary(parent) && current === parent.right) {
    return [{ arm: "right", control: parent, exclusive: false }];
  }
  if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
    return [{ arm: String(parent.getStart()), control: parent.parent.parent, exclusive: false }];
  }
  return exceptionArms(current);
}

function ifArms(current: ts.Node, parent: ts.IfStatement): ControlArm[] {
  const arms: ControlArm[] = [];
  if (current === parent.thenStatement) {
    arms.push({ arm: "then", control: parent, exclusive: true });
  }
  if (current === parent.elseStatement) {
    arms.push({ arm: "else", control: parent, exclusive: true });
  }
  return arms;
}

function conditionalArms(current: ts.Node, parent: ts.ConditionalExpression): ControlArm[] {
  const arms: ControlArm[] = [];
  if (current === parent.whenTrue) {
    arms.push({ arm: "true", control: parent, exclusive: true });
  }
  if (current === parent.whenFalse) {
    arms.push({ arm: "false", control: parent, exclusive: true });
  }
  return arms;
}

export function haveOppositeSharedArm(
  left: readonly ControlArm[],
  right: readonly ControlArm[],
): boolean {
  return left.some(
    (leftArm) =>
      leftArm.exclusive &&
      right.some(
        (rightArm) =>
          rightArm.exclusive &&
          leftArm.control === rightArm.control &&
          leftArm.arm !== rightArm.arm,
      ),
  );
}

export function sameControlArms(
  left: readonly ControlArm[],
  right: readonly ControlArm[],
): boolean {
  return (
    left.length === right.length &&
    left.every((leftArm) =>
      right.some(
        (rightArm) => leftArm.control === rightArm.control && leftArm.arm === rightArm.arm,
      ),
    )
  );
}

export function shareSwitchControl(
  left: readonly ControlArm[],
  right: readonly ControlArm[],
): boolean {
  return left.some(
    (leftArm) =>
      !leftArm.exclusive &&
      right.some((rightArm) => !rightArm.exclusive && leftArm.control === rightArm.control),
  );
}

function exceptionArms(current: ts.Node): ControlArm[] {
  const { parent } = current;
  if (ts.isTryStatement(parent) && current === parent.tryBlock) {
    return [{ arm: "try", control: parent, exclusive: false }];
  }
  if (ts.isCatchClause(parent)) {
    return [{ arm: "catch", control: parent.parent, exclusive: false }];
  }
  return [];
}
