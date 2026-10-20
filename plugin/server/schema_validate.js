/**
 * Server-side validation of tool arguments.
 *
 * The input schema published to the client is a promise. This server keeps it,
 * because the alternative is worse than a rejected call:
 *
 *   - A missing required field used to become `String(undefined)`, so
 *     `jianying_open_draft` without a name opened a draft literally called
 *     "undefined" in the user's real project folder.
 *   - A misspelled key used to be ignored. `duraton` silently dropped the
 *     duration, and the clip landed at the wrong place on the timeline.
 *
 * Both are silent wrong answers, so the arguments are checked here, before
 * the tool touches anything.
 */
/**
 * Validates a value against the JSON Schema subset this server uses.
 *
 * Returns a list of human-readable problems; an empty list means the value is
 * acceptable.
 */
export function validateAgainstSchema(schema, value, path = "") {
    const errors = [];
    if (!schema || typeof schema !== "object")
        return errors;
    // `anyOf`: the value is acceptable if it satisfies any branch. The branch
    // messages are replaced with one that names both options, because the
    // alternatives here are a number and a duration string.
    if (Array.isArray(schema.anyOf)) {
        const branches = schema.anyOf;
        const satisfied = branches.some((branch) => validateAgainstSchema(branch, value, path).length === 0);
        if (!satisfied) {
            errors.push(`${label(path)} must be a number of seconds or a duration string such as "1m30s", got ${describe(value)}`);
        }
        return errors;
    }
    if (Array.isArray(schema.enum)) {
        if (!schema.enum.includes(value)) {
            errors.push(`${label(path)} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}, got ${describe(value)}`);
        }
        return errors;
    }
    switch (schema.type) {
        case "string":
            if (typeof value !== "string") {
                errors.push(`${label(path)} must be a string, got ${describe(value)}`);
            }
            break;
        case "number":
            // A field the engine normalises with `Number()` also accepts a numeric
            // string. A string that is not a number is refused rather than
            // silently becoming zero.
            if (schema.acceptsNumericString && typeof value === "string") {
                const trimmed = value.trim();
                const parsed = Number(trimmed);
                if (!trimmed || !Number.isFinite(parsed)) {
                    errors.push(`${label(path)} must be a number, got ${describe(value)}`);
                }
                break;
            }
            if (typeof value !== "number" || !Number.isFinite(value)) {
                errors.push(`${label(path)} must be a number, got ${describe(value)}`);
            }
            break;
        case "boolean":
            if (typeof value !== "boolean") {
                errors.push(`${label(path)} must be true or false, got ${describe(value)}`);
            }
            break;
        case "array": {
            if (!Array.isArray(value)) {
                errors.push(`${label(path)} must be an array, got ${describe(value)}`);
                break;
            }
            if (schema.items) {
                value.forEach((item, index) => {
                    errors.push(...validateAgainstSchema(schema.items, item, `${path}[${index}]`));
                });
            }
            break;
        }
        case "object": {
            if (value === null || typeof value !== "object" || Array.isArray(value)) {
                errors.push(`${label(path)} must be an object, got ${describe(value)}`);
                break;
            }
            const obj = value;
            const properties = schema.properties ?? {};
            for (const key of schema.required ?? []) {
                if (!Object.prototype.hasOwnProperty.call(obj, key) || obj[key] === undefined) {
                    errors.push(`"${key}" is required`);
                }
            }
            for (const [key, sub] of Object.entries(properties)) {
                if (!Object.prototype.hasOwnProperty.call(obj, key))
                    continue;
                if (obj[key] === undefined)
                    continue;
                errors.push(...validateAgainstSchema(sub, obj[key], path ? `${path}.${key}` : key));
            }
            // Unknown keys are refused rather than ignored. Every key of this API
            // changes the edit, so a key the server does not know is a mistake the
            // caller needs to hear about.
            //
            // The membership test has to be an own-property test. `key in
            // properties` walks the prototype chain, so "__proto__", "constructor"
            // and "toString" would all look like known keys and slip through.
            const unknown = Object.keys(obj).filter((key) => !Object.prototype.hasOwnProperty.call(properties, key));
            if (unknown.length > 0) {
                const accepted = Object.keys(properties);
                errors.push(`unknown argument${unknown.length > 1 ? "s" : ""} ` +
                    unknown.map((k) => `"${k}"`).join(", ") +
                    (accepted.length
                        ? `; accepted: ${accepted.join(", ")}`
                        : "; this tool takes no arguments"));
            }
            break;
        }
    }
    return errors;
}
/**
 * The name of a value in an error message.
 */
function label(path) {
    return path || "arguments";
}
/**
 * A short, safe description of an unexpected value.
 */
function describe(value) {
    if (value === undefined)
        return "nothing";
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return `an array of ${value.length}`;
    if (typeof value === "object")
        return "an object";
    if (typeof value === "string") {
        return value.length > 40 ? `"${value.slice(0, 40)}…"` : `"${value}"`;
    }
    return String(value);
}
