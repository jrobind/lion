/* eslint-disable no-param-reassign */
const fs = require('fs');
const semver = require('semver');
const pathLib = require('path');
const { LogService } = require('./LogService.js');
const { QueryService } = require('./QueryService.js');
const { ReportService } = require('./ReportService.js');
const { InputDataService } = require('./InputDataService.js');
const { toPosixPath } = require('../utils/to-posix-path.js');
const { getFilePathRelativeFromRoot } = require('../utils/get-file-path-relative-from-root.js');

/**
 * @typedef {import('../types/core').AnalyzerName} AnalyzerName
 * @typedef {import('../types/core').PathFromSystemRoot} PathFromSystemRoot
 * @typedef {import('../types/core').QueryOutput} QueryOutput
 * @typedef {import('../types/core').ProjectInputData} ProjectInputData
 * @typedef {import('../types/core').ProjectInputDataWithMeta} ProjectInputDataWithMeta
 * @typedef {import('../types/core').AnalyzerQueryResult} AnalyzerQueryResult
 * @typedef {import('../types/core').MatchAnalyzerConfig} MatchAnalyzerConfig
 */

/**
 * Analyzes one entry: the callback can traverse a given ast for each entry
 * @param {ProjectInputDataWithMeta} projectData
 * @param {function} astAnalysis
 */
async function analyzePerAstEntry(projectData, astAnalysis) {
  const entries = [];
  for (const { file, ast, context: astContext } of projectData.entries) {
    const relativePath = getFilePathRelativeFromRoot(file, projectData.project.path);
    const context = { code: astContext.code, relativePath, projectData };
    LogService.debug(`${pathLib.resolve(projectData.project.path, file)}`);
    const { result, meta } = await astAnalysis(ast, context);
    entries.push({ file: relativePath, meta, result });
  }
  const filteredEntries = entries.filter(({ result }) => Boolean(result.length));
  return filteredEntries;
}

/**
 * Transforms QueryResult entries to posix path notations on Windows
 * @param {object[]|object} data
 */
function posixify(data) {
  if (!data) {
    return;
  }
  if (Array.isArray(data)) {
    data.forEach(posixify);
  } else if (typeof data === 'object') {
    Object.entries(data).forEach(([k, v]) => {
      if (Array.isArray(v) || typeof v === 'object') {
        posixify(v);
      }
      // TODO: detect whether filePath instead of restricting by key name?
      else if (typeof v === 'string' && k === 'file') {
        data[k] = toPosixPath(v);
      }
    });
  }
}

/**
 * This method ensures that the result returned by an analyzer always has a consistent format.
 * By returning the configuration for the queryOutput, it will be possible to run later queries
 * under the same circumstances
 * @param {QueryOutput} queryOutput
 * @param {object} configuration
 * @param {Analyzer} analyzer
 */
function ensureAnalyzerResultFormat(queryOutput, configuration, analyzer) {
  const { targetProjectMeta, identifier, referenceProjectMeta } = analyzer;
  const optional = {};
  if (targetProjectMeta) {
    optional.targetProject = targetProjectMeta;
    delete optional.targetProject.path; // get rid of machine specific info
  }
  if (referenceProjectMeta) {
    optional.referenceProject = referenceProjectMeta;
    delete optional.referenceProject.path; // get rid of machine specific info
  }

  /** @type {AnalyzerQueryResult} */
  const aResult = {
    queryOutput,
    analyzerMeta: {
      name: analyzer.name,
      requiredAst: analyzer.requiredAst,
      identifier,
      ...optional,
      configuration,
    },
  };

  // For now, delete data relatable to local machine + path data that will recognize
  // projX#v1 (via rootA/projX#v1, rootB/projX#v2) as identical entities.
  // Cleaning up local data paths will make  sure their hashes will be similar
  // across different machines
  delete aResult.analyzerMeta.configuration.referenceProjectPath;
  delete aResult.analyzerMeta.configuration.targetProjectPath;

  const { referenceProjectResult, targetProjectResult } = aResult.analyzerMeta.configuration;

  if (referenceProjectResult) {
    delete aResult.analyzerMeta.configuration.referenceProjectResult;
  } else if (targetProjectResult) {
    delete aResult.analyzerMeta.configuration.targetProjectResult;
  }

  if (Array.isArray(aResult.queryOutput)) {
    aResult.queryOutput.forEach(projectOutput => {
      if (projectOutput.project) {
        delete projectOutput.project.path;
      }
    });
  }

  if (process.platform === 'win32') {
    posixify(aResult);
  }

  return aResult;
}

/**
 * Before running the analyzer, we need two conditions for a 'compatible match':
 * - 1. referenceProject is imported by targetProject at all
 * - 2. referenceProject and targetProject have compatible major versions
 * @param {PathFromSystemRoot} referencePath
 * @param {PathFromSystemRoot} targetPath
 */
function checkForMatchCompatibility(referencePath, targetPath) {
  const refFile = pathLib.resolve(referencePath, 'package.json');
  const referencePkg = JSON.parse(fs.readFileSync(refFile, 'utf8'));
  const targetFile = pathLib.resolve(targetPath, 'package.json');
  const targetPkg = JSON.parse(fs.readFileSync(targetFile, 'utf8'));

  const allTargetDeps = [
    ...Object.entries(targetPkg.devDependencies || {}),
    ...Object.entries(targetPkg.dependencies || {}),
  ];
  const importEntry = allTargetDeps.find(([name]) => referencePkg.name === name);
  if (!importEntry) {
    return { compatible: false, reason: 'no-dependency' };
  }
  if (!semver.satisfies(referencePkg.version, importEntry[1])) {
    return { compatible: false, reason: 'no-matched-version' };
  }
  return { compatible: true };
}

/**
 * If in json format, 'unwind' to be compatible for analysis...
 * @param {AnalyzerQueryResult} targetOrReferenceProjectResult
 */
function unwindJsonResult(targetOrReferenceProjectResult) {
  const { queryOutput } = targetOrReferenceProjectResult;
  const { analyzerMeta } = targetOrReferenceProjectResult.meta;
  return { queryOutput, analyzerMeta };
}

class Analyzer {
  static get requiresReference() {
    return false;
  }

  static get analyzerName() {
    return '';
  }

  get name() {
    return /** @type  {typeof Analyzer} */ (this.constructor).analyzerName;
  }

  // eslint-disable-next-line class-methods-use-this
  get requiredAst() {
    return 'babel';
  }

  /**
   * In a MatchAnalyzer, two Analyzers (a reference and targer) are run.
   * For instance, in a MatchImportsAnalyzer, a FindExportsAnalyzer and FinImportsAnalyzer are run.
   * Their results can be provided as config params.
   * If they are stored in json format, 'unwind' them to be compatible for analysis...
   * @param {MatchAnalyzerConfig} cfg
   */
  static __unwindProvidedResults(cfg) {
    if (cfg.targetProjectResult && !cfg.targetProjectResult.analyzerMeta) {
      cfg.targetProjectResult = unwindJsonResult(cfg.targetProjectResult);
    }
    if (cfg.referenceProjectResult && !cfg.referenceProjectResult.analyzerMeta) {
      cfg.referenceProjectResult = unwindJsonResult(cfg.referenceProjectResult);
    }
  }

  /**
   * @param {AnalyzerConfig} cfg
   * @returns {CachedAnalyzerResult|undefined}
   */
  _prepare(cfg) {
    LogService.debug(`Analyzer "${this.name}": started _prepare method`);
    this.constructor.__unwindProvidedResults(cfg);

    if (!cfg.targetProjectResult) {
      this.targetProjectMeta = InputDataService.getProjectMeta(cfg.targetProjectPath);
    } else {
      this.targetProjectMeta = cfg.targetProjectResult.analyzerMeta.targetProject;
    }

    if (cfg.referenceProjectPath && !cfg.referenceProjectResult) {
      this.referenceProjectMeta = InputDataService.getProjectMeta(cfg.referenceProjectPath);
    } else if (cfg.referenceProjectResult) {
      this.referenceProjectMeta = cfg.referenceProjectResult.analyzerMeta.targetProject;
    }

    /**
     * Create a unique hash based on target, reference and configuration
     */
    this.identifier = ReportService.createIdentifier({
      targetProject: this.targetProjectMeta,
      referenceProject: this.referenceProjectMeta,
      analyzerConfig: cfg,
    });

    // If we have a provided result cfg.referenceProjectResult, we assume the providing
    // party provides compatible results for now...
    if (cfg.referenceProjectPath && !cfg.skipCheckMatchCompatibility) {
      const { compatible, reason } = checkForMatchCompatibility(
        cfg.referenceProjectPath,
        cfg.targetProjectPath,
      );

      if (!compatible) {
        LogService.info(
          `skipping ${LogService.pad(this.name, 16)} for ${
            this.identifier
          }: (${reason})\n${cfg.targetProjectPath.replace(
            `${process.cwd()}/providence-input-data/search-targets/`,
            '',
          )}`,
        );
        return ensureAnalyzerResultFormat(`[${reason}]`, cfg, this);
      }
    }

    /**
     * See if we maybe already have our result in cache in the file-system.
     */
    const cachedResult = Analyzer._getCachedAnalyzerResult({
      analyzerName: this.name,
      identifier: this.identifier,
    });

    if (cachedResult) {
      return cachedResult;
    }

    LogService.info(`starting ${LogService.pad(this.name, 16)} for ${this.identifier}`);

    /**
     * Get reference and search-target data
     */
    if (!cfg.targetProjectResult) {
      this.targetData = InputDataService.createDataObject(
        [cfg.targetProjectPath],
        cfg.gatherFilesConfig,
      );
    }

    if (cfg.referenceProjectPath) {
      this.referenceData = InputDataService.createDataObject(
        [cfg.referenceProjectPath],
        cfg.gatherFilesConfigReference || cfg.gatherFilesConfig,
      );
    }

    return undefined;
  }

  /**
   * @param {QueryOutput} queryOutput
   * @param {AnalyzerConfig} cfg
   * @returns {AnalyzerQueryResult}
   */
  _finalize(queryOutput, cfg) {
    LogService.debug(`Analyzer "${this.name}": started _finalize method`);

    const analyzerResult = ensureAnalyzerResultFormat(queryOutput, cfg, this);
    LogService.success(`finished ${LogService.pad(this.name, 16)} for ${this.identifier}`);
    return analyzerResult;
  }

  /**
   * @param {function} traverseEntry
   */
  async _traverse(traverseEntry) {
    LogService.debug(`Analyzer "${this.name}": started _traverse method`);

    /**
     * Create ASTs for our inputData
     */
    const astDataProjects = await QueryService.addAstToProjectsData(this.targetData, 'babel');
    return analyzePerAstEntry(astDataProjects[0], traverseEntry);
  }

  async execute(customConfig = {}) {
    LogService.debug(`Analyzer "${this.name}": started execute method`);

    const cfg = {
      targetProjectPath: null,
      referenceProjectPath: null,
      ...customConfig,
    };

    /**
     * Prepare
     */
    const analyzerResult = this._prepare(cfg);
    if (analyzerResult) {
      return analyzerResult;
    }

    /**
     * Traverse
     */
    const queryOutput = await this._traverse(() => {});

    /**
     * Finalize
     */
    return this._finalize(queryOutput, cfg);
  }

  /**
   * Gets a cached result from ReportService. Since ReportService slightly modifies analyzer
   * output, we 'unwind' before we return...
   * @param {object} config
   * @param {string} config.analyzerName
   * @param {string} config.identifier
   * @returns {AnalyzerQueryResult|undefined}
   */
  static _getCachedAnalyzerResult({ analyzerName, identifier }) {
    const cachedResult = ReportService.getCachedResult({ analyzerName, identifier });
    if (!cachedResult) {
      return undefined;
    }
    LogService.success(`cached version found for ${identifier}`);

    /** @type {AnalyzerQueryResult} */
    const result = unwindJsonResult(cachedResult);
    result.analyzerMeta.__fromCache = true;
    return result;
  }
}

module.exports = { Analyzer };
