import { deepFreeze } from '../../core/identity/index.js';
import { createManagedMethodId, createManagedTypeId } from '../shared/identity.js';
import { createManagedValidationReport } from '../shared/validation.js';
import { liftWasmFunction } from './lifter.js';
import { parseWasm, probeWasm } from './parser.js';

export class WasmFrontend {
  constructor(options = {}) {
    this.id = 'wasm';
    this.contractVersion = '1.0.0';
    this.semanticVersion = '1.0.0';
    this.options = options;
  }

  async probe(bytes, context = {}) {
    return probeWasm(bytes);
  }

  async open(bytes, context = {}) {
    const wasmModule = parseWasm(bytes, { ...this.options, ...context });
    return wasmModule;
  }

  async *enumerateModules(image, options = {}) {
    yield {
      id: image.moduleId,
      imageId: image.imageId,
      name: 'main',
      formatVersion: image.formatVersion,
    };
  }

  async *enumerateTypes(image, options = {}) {
    for (let i = 0; i < image.types.length; i++) {
      const t = image.types[i];
      yield {
        id: createManagedTypeId(image.moduleId, `type_${i}`),
        moduleId: image.moduleId,
        index: i,
        params: t.params,
        results: t.results,
      };
    }
  }

  async *enumerateMethods(image, options = {}) {
    const importedCount = image.imports.filter((imp) => imp.desc.kind === 0).length;
    const totalFuncs = importedCount + image.functions.length;
    for (let i = 0; i < totalFuncs; i++) {
      const methodId = createManagedMethodId(image.moduleId, i);
      const isImport = i < importedCount;
      const exportEntry = image.exports.find((e) => e.kind === 0 && e.index === i);
      yield {
        id: methodId,
        moduleId: image.moduleId,
        funcIndex: i,
        name: exportEntry ? exportEntry.name : `func_${i}`,
        isImport,
        exportName: exportEntry ? exportEntry.name : null,
      };
    }
  }

  async decodeMethod(method, context = {}) {
    const wasmModule = context.image;
    if (!wasmModule) throw new TypeError('wasm-context-image-required');
    return liftWasmFunction(method.funcIndex, wasmModule, context);
  }

  async validateMethod(decoded, context = {}) {
    const hasUnknowns = decoded.bundles.some((b) => b.completeness === 'unknown');
    const hasPartials = decoded.bundles.some((b) => b.completeness === 'partial');
    const status = hasUnknowns ? 'partial' : hasPartials ? 'partial' : 'valid';
    return createManagedValidationReport({
      targetId: decoded.methodId,
      status,
      completeness: {
        structural: 'complete',
        specValidation: 'valid',
        semanticEffect: status === 'valid' ? 'complete' : 'partial',
      },
    });
  }

  async liftMethod(decoded, validation, context = {}) {
    return decoded;
  }
}
