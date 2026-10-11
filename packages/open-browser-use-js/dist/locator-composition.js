import { isDeepStrictEqual } from "node:util";
// A locator is a finite tree, not a selector program. The engine additionally
// parses CSS with its pinned native parser to reject hidden frame traversal.
export function copyLocatorSteps(steps, nested = false) {
    let count = 0;
    function copy(chain, depth) {
        if (!Array.isArray(chain) || chain.length > 32 || (depth > 0 && !chain.length) || depth > 8)
            throw new Error("Locator tree exceeds chain/depth limits or has an empty operand");
        let element = false;
        return Object.freeze(chain.map(step => {
            if (!step || typeof step !== "object" || ++count > 128)
                throw new Error("Locator tree exceeds 128 steps");
            if ((nested || depth > 0) && (step.kind === "frame" || step.kind === "ref"))
                throw new Error("Nested locators cannot contain frame or ref steps");
            if (["filter", "nth", "first", "last", "and", "or"].includes(step.kind) && !element)
                throw new Error("Locator operation requires a preceding element");
            element = step.kind !== "frame";
            const result = { ...step };
            if (result.kind === "filter") {
                if (result.visible !== undefined && typeof result.visible !== "boolean")
                    throw new Error("visible must be boolean");
                if (result.has !== undefined)
                    result.has = copy(result.has, depth + 1);
                if (result.hasNot !== undefined)
                    result.hasNot = copy(result.hasNot, depth + 1);
            }
            else if (result.kind === "and" || result.kind === "or")
                result.locator = copy(result.locator, depth + 1);
            return Object.freeze(result);
        }));
    }
    return copy(steps, 0);
}
export function relativeLocatorSteps(outer, inner, relative) {
    if (outer.some(step => step.kind === "ref") || inner.some(step => step.kind === "ref"))
        throw new Error("Ref locators cannot be composed");
    const prefixLength = (steps) => steps.reduce((last, step, index) => step.kind === "frame" ? index + 1 : last, 0);
    const outerEnd = prefixLength(outer), innerEnd = prefixLength(inner);
    if ((!relative || innerEnd > 0) && !isDeepStrictEqual(outer.slice(0, outerEnd), inner.slice(0, innerEnd)))
        throw new Error("Locator operands must have the same frame prefix");
    const operand = inner.slice(innerEnd);
    if (!operand.length)
        throw new Error("Locator operand must be a nonempty element chain");
    return copyLocatorSteps(operand, true);
}
export function assertCombinedLocatorBudget(...chains) {
    let count = 0;
    function visit(chain) {
        for (const step of chain) {
            if (++count > 128)
                throw new Error("Action locator trees exceed 128 steps");
            if (step.kind === "filter") {
                if (step.has)
                    visit(step.has);
                if (step.hasNot)
                    visit(step.hasNot);
            }
            else if (step.kind === "and" || step.kind === "or")
                visit(step.locator);
        }
    }
    chains.forEach(visit);
}
