import { BuilderOptions, DecoratorType, State as StateBase, TypeScriptJsonSchemaBuilder, TypeWorxDecorator, Utilities as utils } from '@mapistry/typeworx';
import * as debug from 'debug';
import * as fs from 'fs';
import * as ts from 'ts-simple-ast';
const log = debug('typeworx-swagger');

export function isMethodPublic(node: ts.MethodDeclaration) {
    // tslint:disable-next-line:no-bitwise
    return node.getCombinedModifierFlags() & ts.ts.ModifierFlags.Public;
}

function sortJson(obj) {
    return Object.keys(obj).sort().reduce((o, curr) => {
        let currentObject = obj[curr];
        if (typeof currentObject === 'object' && !(currentObject instanceof Array)) {
            currentObject = sortJson(currentObject);
        }
        o[curr] = currentObject;
        return o;
    }, {});
}

export enum ResponseType {
    Standard,
    Success,
}

export interface State extends StateBase {
    swagger?: any;
    lastPath?: string;
    lastPathValue?: string;
    builder?: TypeScriptJsonSchemaBuilder;
    lastVerbObject?: any;
    ignoreCustomJsDocTags?: boolean;
    globalTags?: string[];
    generatedVerbObjects?: any[];
    baseSwaggerPath?: string;
}

function setupState(state: State) {
    const swaggerDoc = {
        basePath: '/v1',
        consumes: ['application/json'],
        info: {
            title: 'Default API',
            version: '0.0.1',
            description: 'Default API description.',
        },
        swagger: '2.0',
        host: 'localhost:8080',
        paths: {},
    };
    state.swagger = swaggerDoc;
    if (state.baseSwaggerPath) {
        const newSwagger = JSON.parse(fs.readFileSync(state.baseSwaggerPath, 'utf-8'));
        state.swagger = Object.assign({}, swaggerDoc, newSwagger);
    }
    state.builder = new TypeScriptJsonSchemaBuilder({ ignoreCustomJsDocTags: state.ignoreCustomJsDocTags });
}

function afterAll(state: State) {
    if (state.swagger) {
        Object.assign(state.swagger, state.builder.getSchemas());
    }
    state.outputs.decoratorResult = JSON.stringify(sortJson(state.swagger), null, 4);
}

function getUniqueTypeNameFromGenerics(type: ts.Type) {
    if (type == null) {
        return null;
    }
    const typeArgs = type.getTypeArguments();
    const hasTypeArgs = typeArgs && typeArgs.length;
    const symbol = type.getSymbol();
    const name = symbol ? symbol.getName() : type.getText();
    return `${name}${hasTypeArgs ? '_' + typeArgs.map((x) => getUniqueTypeNameFromGenerics(x)).join('_') : ''}`;
}

function getEnumValueFromPropertyAccessExpression<T>(expression: ts.PropertyAccessExpression) {
    return ((expression.getSymbol().getValueDeclaration() as ts.EnumMember).getValue() as any) as T;
}

function getResponseTypeFromDecorator(decorator: ts.Decorator): ResponseType {
    const expression: any = decorator.getArguments()[2];
    if (expression) {
        return getEnumValueFromPropertyAccessExpression<ResponseType>(expression);
    }
    return ResponseType.Standard;
}

function getResponseFromDecorator(builder: TypeScriptJsonSchemaBuilder, decorator: ts.Decorator): { responseType: ResponseType, responseDefinition: any } {
    const values = utils.getLiteralDecoratorParameters(decorator);
    const statusCode = values[0];
    let description = values[1];
    if (description && description.getSymbol) {
        description = '';
    }
    const responseType = values[2] ? getEnumValueFromPropertyAccessExpression<ResponseType>(values[2]) : ResponseType.Standard;
    const example = values[3] ? utils.parseObjectLiteralExpression(values[3]) : null;
    let type: ts.Type;
    const typeArguments = decorator.getTypeArguments();
    if (typeArguments && typeArguments.length) {
        type = decorator.getTypeArguments()[0].getType();
    }
    return {
        responseType: responseType || ResponseType.Standard,
        responseDefinition: getResponseFromValues(builder, statusCode, type, description, example),
    };
}

function getResponseFromValues(builder: TypeScriptJsonSchemaBuilder, statusCode: number, returnType?: ts.Type, description?: string, example?: any) {
    const schema = returnType ? builder.getJsonType(returnType) : null;
    const result: any = {
        [statusCode]: {
            description: description || 'No description.',
            schema: schema || {},
        },
    };
    if (example) {
        result[statusCode].examples = { 'application/json': example };
    }
    return result;

}

function getParameterFromDecorator(state: State, parameter: ts.ParameterDeclaration, decorator: ts.Decorator): { responseType: ResponseType, responseDefinition: any } {
    const values = utils.getLiteralDecoratorParameters(decorator);
    const decoratorName = decorator.getName();
    const name = decoratorName === 'Body' ? 'body' : values[0] || parameter.getName();
    const inLocation = decoratorName.toLowerCase();
    let description = null;
    const parent = parameter.getAncestors().find((a) => a.getKind() === ts.SyntaxKind.MethodDeclaration) as ts.MethodDeclaration;
    if (parent) {
        const docs = parent.getJsDocs();
        for (const doc of docs) {
            const tags = doc.getTags();
            for (const tag of tags) {
                const tagNameNode = tag.getTagNameNode();
                if (tagNameNode) {
                    if (tagNameNode.getText() === 'param') {
                        const children = tag.getChildren();
                        if (children[1] && children[1].getText() === parameter.getName()) {
                            description = tag.getComment() || '';
                            break;
                        }
                    }
                }
            }
            if (description !== null) {
                break;
            }
        }
    }
    const type = parameter.getType();
    return getParameterFromValues(state, inLocation, name, type, description || '', !parameter.isOptional());
}

function getParameterFromValues(state: State, inLocation: string, name: string, returnType?: ts.Type, description?: string, required?: boolean) {
    if (inLocation === 'path' && (!state.lastPathValue || state.lastPathValue.indexOf(`{${name}}`) < 0)) {
        throw new Error(`Unable to find matching parameter in path for parameter ${name}`);
    }
    const builder = state.builder;
    const schema = builder.getJsonType(returnType);
    const isAny = schema && Object.keys(schema).length === 0;
    const result: any = {
        in: inLocation,
        name,
        required,
        description: description || 'No description.',
    };
    if (['header', 'path', 'query'].indexOf(inLocation) > -1) {
        log(`Processing Path: Pending Result ${JSON.stringify(result)}, Schema ${JSON.stringify(schema || 'none')}`);
        if (!isAny) {
            if (!schema || !schema.type || ['string', 'boolean', 'number'].indexOf(schema.type) < 0) {
                throw new Error('Parameter/Query/Header decorators must be associated with parameters that have a primitive type.');
            }
        }
        result.type = isAny ? {} : schema.type;
    } else {
        result.schema = schema;
    }
    return result;
}

function verbWrapper() {
    return (state: State, node: ts.MethodDeclaration, routeDecorator: ts.Decorator) => {
        createSwaggerForVerbDecorator(state, node, routeDecorator);
    };
}

function parameterWrapper() {
    return (state: State, node: ts.ParameterDeclaration, routeDecorator: ts.Decorator) => {
        const result = getParameterFromDecorator(state, node, routeDecorator);
        const verbObject = state.lastVerbObject;
        const parameters = verbObject.parameters = verbObject.parameters || [];
        parameters.push(result);
    };
}

function createSwaggerForVerbDecorator(state: State, node: ts.MethodDeclaration, decorator: ts.Decorator) {
    const builder = state.builder;
    const isCustom = decorator.getName() === 'CustomHttp';
    // tslint:disable-next-line:no-bitwise
    let path = state.lastPath;
    if (isMethodPublic(node)) {
        const decoratorValues = utils.getLiteralDecoratorParameters(decorator);
        const otherDecorators = node.getDecorators().filter((d) => d !== decorator);
        let verb: string = decorator.getName().toLowerCase();
        let pathValue: string;
        if (decoratorValues && decoratorValues.length) {
            verb = isCustom ? decoratorValues[0] : verb;
            pathValue = decoratorValues[isCustom ? 1 : 0] || '';
        }
        path = `${path}${pathValue ? `/${pathValue}` : ''}`;
        state.lastPathValue = pathValue;
        const pathObject = state.swagger.paths[path] = state.swagger.paths[path] || {};
        let verbObject: any = pathObject[verb];
        if (verbObject) {
            throw new Error('Verb already defined for path');
        }
        const jsDocs = node.getJsDocs();
        const methodName = node.getName();
        verbObject = {
            operationId: methodName,
            produces: ['application/json'],
            description: (jsDocs && jsDocs.length) ? jsDocs[0].getComment() || methodName : methodName,
        };
        pathObject[verb] = verbObject;
        (state.generatedVerbObjects = state.generatedVerbObjects || []).push(verbObject);

        let hasSuccessResponse = false;
        for (const otherDecorator of otherDecorators) {
            const name = otherDecorator.getName();
            if (name.indexOf('Response') > -1) {
                const responseType = getResponseTypeFromDecorator(otherDecorator);
                if (responseType === ResponseType.Success) {
                    hasSuccessResponse = true;
                    break;
                }
            }
        }
        if (!hasSuccessResponse) {
            const responses = verbObject.responses = {};
            const returnType = node.getReturnType();
            if (returnType) {
                if (returnType.getSymbol().getName() !== 'Promise') {
                    throw new Error('Return type must be a promise');
                }
                const type = returnType.getTypeArguments()[0];
                const result = getResponseFromValues(builder, 200, type, '');
                Object.assign(responses, result);
            }
        }
        const parameters = node.getParameters() || [];
        const verbParameters = verbObject.parameters = verbObject.parameters || [];
        for (const parameter of parameters) {
            let isParameterManaged = false;
            const parameterDecorators = parameter.getDecorators() || [];
            for (const parameterDecorator of parameterDecorators) {
                const info = utils.getTypeWorxDecoratorMethodInfoFromDecorator(parameterDecorator);
                if (info && info.options.isSwaggerParameterDecorator) {
                    isParameterManaged = true;
                    break;
                }
                if (!info) {
                    // Not a parameter we care about.
                    isParameterManaged = true;
                }
            }
            if (!isParameterManaged) {
                const parameterName = parameter.getName();
                verbParameters.push(getParameterFromValues(state, 'path', parameterName, parameter.getType(), 'Ok.', !parameter.isOptional()));

            }

        }
        state.lastVerbObject = verbObject;
    }

}

function getUniqueSwaggerTags(arr: string[]) {
    const dictionary = arr.reduce((obj, curr) => {
        obj[curr.toLowerCase()] = curr;
        return obj;
    }, {});
    return Object.keys(dictionary).map((x) => dictionary[x]);
}

function afterTags(state: State, node: ts.MethodDeclaration | ts.ClassDeclaration, decorator: ts.Decorator) {
    const flags = node.getCombinedModifierFlags();
    // tslint:disable-next-line:no-bitwise
    if (flags & ts.ObjectFlags.Class) {
        const parameters = utils.getLiteralDecoratorParameters(decorator);
        const verbs = state.generatedVerbObjects;
        if (!verbs) {
            throw new Error('Something went wrong - make sure you have generated using verb decorators.');
        }
        for (const verb of verbs) {
            verb.tags = getUniqueSwaggerTags((verb.tags || []).concat(parameters)).sort();
        }
        state.generatedVerbObjects = null;
    }
}

export class Decorators {
    @TypeWorxDecorator({ namespace: 'swagger', beforeAll: setupState, afterAll, decoratorType: DecoratorType.Class, order: -1 })
    public static Route(value?: string): any {
        return (state: State, node: ts.ClassDeclaration, routeDecorator: ts.Decorator) => {
            if (node.getKindName() !== 'ClassDeclaration') {
                throw new Error('Only valid on class.');
            }
            const builder = state.builder;
            const swaggerDoc = state.swagger;
            const decoratorValues = utils.getLiteralDecoratorParameters(routeDecorator);
            const className = node.getName();
            const pathName = '/' + ((decoratorValues && decoratorValues.length) ? decoratorValues[0] : node.getName());
            state.lastPath = pathName;
        };
    }

    @TypeWorxDecorator({ namespace: 'swagger', decoratorType: DecoratorType.Method, order: -1 })
    public static Get(value?: string): any {
        return verbWrapper();
    }

    @TypeWorxDecorator({ namespace: 'swagger', decoratorType: DecoratorType.Method, order: -1 })
    public static Post(value?: string): any {
        return verbWrapper();
    }

    @TypeWorxDecorator({ namespace: 'swagger', decoratorType: DecoratorType.Method, order: -1 })
    public static Put(value?: string): any {
        return verbWrapper();
    }

    @TypeWorxDecorator({ namespace: 'swagger', decoratorType: DecoratorType.Method, order: -1 })
    public static Patch(value?: string): any {
        return verbWrapper();
    }

    @TypeWorxDecorator({ namespace: 'swagger', decoratorType: DecoratorType.Method, order: -1 })
    public static Delete(value?: string): any {
        return verbWrapper();
    }

    @TypeWorxDecorator({ namespace: 'swagger', decoratorType: DecoratorType.Method, order: -1 })
    public static CustomHttp(verb: string, value?: string): any {
        return verbWrapper();
    }

    @TypeWorxDecorator({ namespace: 'swagger', decoratorType: DecoratorType.Method })
    public static Response<T = any>(statusCode: number, description?: string, responseType?: ResponseType, example?: T): any {
        return (state: State, node: ts.MethodDeclaration, routeDecorator: ts.Decorator) => {
            const verbObject = state.lastVerbObject;
            if (!verbObject) {
                throw new Error('Response decorator can only be used in conjunction with a HTTP verb decorator.');
            }
            const responses = verbObject.responses = verbObject.responses || {};
            Object.assign(responses, getResponseFromDecorator(state.builder, routeDecorator).responseDefinition);
        };
    }

    // tslint:disable-next-line:no-bitwise
    @TypeWorxDecorator({ namespace: 'swagger', decoratorType: DecoratorType.Method | DecoratorType.Class, after: afterTags })
    public static Tags(...value: string[]): any {
        return (state: State, node: ts.MethodDeclaration | ts.ClassDeclaration, routeDecorator: ts.Decorator) => {
            const flags = node.getCombinedModifierFlags();
            const parameters = utils.getLiteralDecoratorParameters(routeDecorator) as string[];

            // tslint:disable-next-line:no-bitwise
            if (!(flags & ts.ObjectFlags.Class)) {
                const verbObject = state.lastVerbObject;
                if (!verbObject) {
                    throw new Error('Tag decorator can only be used in conjunction with a Route or HTTP verb decorator.');
                }
                verbObject.tags = getUniqueSwaggerTags(parameters.sort());
            }
        };
    }

    @TypeWorxDecorator({ namespace: 'swagger', decoratorType: DecoratorType.Method, after: afterTags })
    public static Security(securityName: string, scopes?: string[], destinationProperty?: string): any {
        return (state: State, node: ts.MethodDeclaration | ts.ClassDeclaration, routeDecorator: ts.Decorator) => {
            const parameters = utils.getLiteralDecoratorParameters(routeDecorator);
            const resolvedSecurityName = parameters[0];
            const resolvedScopes = (parameters[1] &&
                parameters[1].getKindName &&
                parameters[1].getKindName() === 'ArrayLiteralExpression') ? JSON.parse(parameters[1].getText().replace(/'/g, `"`)) : [];
            const resolvedDestinationProperty = parameters[2] || 'security';
            // tslint:disable-next-line:no-bitwise
            const verbObject = state.lastVerbObject;
            if (!verbObject) {
                throw new Error('Tag decorator can only be used in conjunction with a Route or HTTP verb decorator.');
            }
            const security: any[] = verbObject[resolvedDestinationProperty] = verbObject[resolvedDestinationProperty] || [];
            security.push({
                [resolvedSecurityName]: resolvedScopes,
            });
            if (resolvedDestinationProperty.toLowerCase() !== 'security') {
                (verbObject.security = verbObject.security || []).push({ [resolvedSecurityName]: [] });
            }
        };
    }

    @TypeWorxDecorator({ namespace: 'swagger', decoratorType: DecoratorType.Parameter, options: { isSwaggerParameterDecorator: true } })
    public static Body(): any {
        return parameterWrapper();
    }
    @TypeWorxDecorator({ namespace: 'swagger', decoratorType: DecoratorType.Parameter, options: { isSwaggerParameterDecorator: true } })
    public static Path(name?: string): any {
        return parameterWrapper();
    }
    @TypeWorxDecorator({ namespace: 'swagger', decoratorType: DecoratorType.Parameter, options: { isSwaggerParameterDecorator: true } })
    public static Query(name?: string): any {
        return parameterWrapper();
    }
    @TypeWorxDecorator({ namespace: 'swagger', decoratorType: DecoratorType.Parameter, options: { isSwaggerParameterDecorator: true } })
    public static Header(name?: string): any {
        return parameterWrapper();
    }
}
