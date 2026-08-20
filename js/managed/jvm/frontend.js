import { deepFreeze } from '../../core/identity/index.js';
import { createManagedMethodId, createManagedTypeId } from '../shared/identity.js';
import { createManagedValidationReport } from '../shared/validation.js';
import { liftJvmMethod } from './lifter.js';
import { parseJvm, probeJvm } from './parser.js';

export class JvmFrontend {
  constructor(options = {}) {
    this.id = 'jvm';
    this.contractVersion = '1.0.0';
    this.semanticVersion = '1.0.0';
    this.options = options;
  }

  async probe(bytes, context = {}) {
    return probeJvm(bytes);
  }

  async open(bytes, context = {}) {
    const jvmClass = parseJvm(bytes, { ...this.options, ...context });
    return jvmClass;
  }

  async *enumerateModules(image, options = {}) {
    yield {
      id: image.moduleId,
      imageId: image.imageId,
      name: `${image.thisClassName}.class`,
      formatVersion: image.formatVersion,
    };
  }

  async *enumerateTypes(image, options = {}) {
    yield {
      id: createManagedTypeId(image.moduleId, image.thisClassName),
      moduleId: image.moduleId,
      thisClassName: image.thisClassName,
      superClassName: image.superClassName,
      interfaces: image.interfaces,
      accessFlags: image.accessFlags,
    };
  }

  async *enumerateMethods(image, options = {}) {
    for (let i = 0; i < image.methods.length; i++) {
      const meth = image.methods[i];
      const methodId = createManagedMethodId(image.moduleId, i, meth.name);
      yield {
        id: methodId,
        moduleId: image.moduleId,
        methodIdx: i,
        name: meth.name,
        descriptor: meth.descriptor,
        accessFlags: meth.accessFlags,
      };
    }
  }

  async decodeMethod(method, context = {}) {
    const jvmClass = context.image;
    if (!jvmClass) throw new TypeError('jvm-context-image-required');
    return liftJvmMethod(method.methodIdx, jvmClass, context);
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
