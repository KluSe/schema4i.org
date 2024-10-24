
function urlToDomain(url) {
    return /^(?:https?:\/\/)(.*?)\/?$/.exec(url)[1];
}

/**
 * @param {string} url 
 * @param {Record<string, string>} knownPrefixes 
 */
function resolvePrefixes(url, knownPrefixes){
    const regexResult = /^(?:(?:https?:\/\/([^/]+)\/)|([\w]+):)(\w+)(?:#\w*)?$/.exec(url);
    if (!regexResult) {
        throw new Error(`${url} is not a valid url`);
    }
    const [, domain, prefix, localName] = regexResult;
    if (prefix && !knownPrefixes[prefix]) {
        throw new Error(`${url} references unknown prefix ${prefix}`);
    }
    return {
        localName,
        domain: prefix ? knownPrefixes[prefix] : domain,
    }
}

/**
 * @param {string} type
 * @param {any} typeObject
 * @param {string} domain
 * @param {Record<string, string>?} knownPrefixes
 * @param {boolean?} ignoreMissing
 * @returns {string}
 */
function processType(type, typeObject, domain, knownPrefixes, ignoreMissing) {
    if (type === '@vocab' && typeObject['@context']) {
        const { localName: vocabLocalName, domain: vocabDomain } = resolvePrefixes(typeObject['@context']['@vocab'], knownPrefixes);
        if (vocabDomain === domain) {
            return vocabLocalName;
        }
        // Foreign enums are not included in the types for the schema
        return 'string';
    }
    const { localName, domain: typeDomain } = resolvePrefixes(type, knownPrefixes);
    if (typeDomain === domain) {
        return localName;
    }
    // TODO: Referencing types from foreign schemas is not supported yet
    if (!ignoreMissing) {
        throw new Error(`Unknown type ${type}`);
    }
}

class FieldDefinition {
    /** @type {string} */
    name;
    /** @type {string} */
    description;
    /** @type {string[]} */
    types;
    /** @type {'one'|'many'|'any'} */
    cardinality;
    /** @type {boolean} */
    required;

    /**
     * @param {string} name 
     * @param {string} description 
     * @param {string[]} types 
     * @param {string} typesHint 
     */
    constructor(name, description, types, typesHint = '') {
        this.name = name;
        this.description = description;
        this.types = types;
        this.required = typesHint.includes('required');
        this.cardinality = typesHint.includes('singleton') ? 'one' : (typesHint.includes('multiple') ? 'many' : 'any');
    }
}

class TypeDefinition {
    /** @type {string} */
    type;
    /** @type {string?} */
    description;
    /** @type {string[]} */
    baseTypes = [];
    /** @type {string?} */
    url;
    /** @type {FieldDefinition[]} */
    fields = [];
    /** @type {FieldDefinition?} */
    simpleType;
    /** @type {{title: string, data: string}[]} */
    examples = [];
    /** @type {Record<string, string>?} */
    enumValues;
    
    /**
     * @param {string} domain 
     * @param {any} srcFile 
     */
    constructor(domain, srcFile) {
        try {
            this.type = srcFile.type;
            this.description = srcFile.description;
            this.url = srcFile.uri;
            this.baseTypes = (srcFile.base || []).map(base => processType(base['@id'], base, domain));
            if (!srcFile.context) {
                throw new Error(`type ${this.type} has no context`);
            }
            /** @type {FieldDefinition} */
            let thisDef;
            const context = srcFile.context['@context'];
            const knownPrefixes = Object.fromEntries(
                Object.entries(context).
                filter(([_, value]) => typeof value === 'string' && /^https?:\/\//.test(value)).
                map(([prefix, url]) => [prefix, urlToDomain(url)])
            );

            const fieldDefs = Object.entries(context).filter(([_, entry]) => typeof entry === 'object');

            function getEntryTypes(key, entry) {
                if (entry['@type']) {
                    return [processType(entry['@type'], entry, domain, knownPrefixes)];
                } else if (srcFile.multipletypes[key]) {
                    return srcFile.multipletypes[key].map(t => processType(t['@id'], t, domain));
                } else {
                    throw new Error(`Property ${key} on type ${this.type} has no type defined`);
                }
            }

            this.fields = fieldDefs.map(([key, entry]) => {
                if (processType(entry["@id"], entry, domain, knownPrefixes, true) === this.type) {
                    thisDef = new FieldDefinition(key, this.getFieldDescription(entry), getEntryTypes(key, entry), 'singleton');
                    return;
                }
                if (key === 'URL') {
                    key = '@id';
                }
                return new FieldDefinition(key, this.getFieldDescription(entry), getEntryTypes(key, entry), entry['types-hint']);
            }).filter(v => typeof v !== 'undefined');
            if (this.baseTypes.includes('Enumeration')) {
                const enumValues = Object.entries(context).filter(([_, entry]) => typeof entry === 'string' && resolvePrefixes(entry, knownPrefixes).domain === domain).map(([value, key]) => ({
                    key: key.split('#').pop(),
                    value
                }));
                thisDef = new FieldDefinition(this.type, '', enumValues.map(({ key }) => `'${key}'`), 'singleton');
                this.enumValues = {};
                for (const { key, value }
                    of enumValues) {
                    this.enumValues[key] = value;
                }
            }
            if (this.fields.length === 0 && thisDef) {
                this.simpleType = thisDef;
            }
            this.examples = (srcFile.playground || []).map(pg => ({ title: pg.title, data: pg.input }));
        } catch (e) {
            throw new Error(`generating type ${this.type} failed: ${e.message}`);
        }
    }

    listAncestors( /** @type {TypeDefinition[]}*/ typeDefinitions) {
        const directAncestors = typeDefinitions.filter(t => this.baseTypes.includes(t.type));
        /** @type {TypeDefinition[]}*/
        const allAncestors = [];
        let nextGenAncestors = directAncestors;
        do {
            allAncestors.push(...nextGenAncestors);
            nextGenAncestors = typeDefinitions.filter(t => !allAncestors.includes(t) && nextGenAncestors.some(a => a.baseTypes.includes(t.type)));
        } while (nextGenAncestors.length > 0);
        return allAncestors;
    }

    listDescendants( /** @type {TypeDefinition[]}*/ typeDefinitions) {
        const directDescendants = typeDefinitions.filter(t => t.baseTypes.includes(this.type));
        /** @type {TypeDefinition[]}*/
        const allDescendants = [];
        let nextGenDescendants = directDescendants;
        do {
            allDescendants.push(...nextGenDescendants);
            nextGenDescendants = typeDefinitions.filter(t => !allDescendants.includes(t) && nextGenDescendants.some(a => t.baseTypes.includes(a.type)));
        } while (nextGenDescendants.length > 0);
        return allDescendants;
    }

    getFieldDescription(entry) {
        // TODO: Would be nice to read the description from the type definition. But at this point there is no way
        // to guarantee that the type definition is already loaded. It would take a second round of processing for the fields.
        return '';
    }
}

module.exports = {
    TypeDefinition,
    FieldDefinition,
};