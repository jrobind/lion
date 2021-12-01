/* eslint-disable import/no-extraneous-dependencies */
const fs = require('fs');
const pathLib = require('path');
const { performance } = require('perf_hooks');
const providenceModule = require('../program/providence.js');
const { QueryService } = require('../program/core/QueryService.js');
const { InputDataService } = require('../program/core/InputDataService.js');
const { LogService } = require('../program/core/LogService.js');
const { flatten } = require('./cli-helpers.js');

async function getExtendDocsResults({
  referenceProjectPaths,
  prefixCfg,
  extensions,
  allowlist,
  allowlistReference,
  cwd,
}) {
  const monoPkgs = InputDataService.getMonoRepoPackages(cwd);

  const results = await providenceModule.providence(
    QueryService.getQueryConfigFromAnalyzer('match-paths', { prefix: prefixCfg }),
    {
      gatherFilesConfig: {
        extensions: extensions || ['.js'],
        allowlist: allowlist || ['!coverage', '!test'],
      },
      gatherFilesConfigReference: {
        extensions: extensions || ['.js'],
        allowlist: allowlistReference || ['!coverage', '!test'],
      },
      queryMethod: 'ast',
      report: false,
      targetProjectPaths: [pathLib.resolve(cwd)],
      referenceProjectPaths,
      // For mono repos, a match between root package.json and ref project will not exist.
      // Disable this check, so it won't be a blocker for extendin docs
      skipCheckMatchCompatibility: Boolean(monoPkgs),
    },
  );

  const queryOutputs = flatten(
    results.map(result => result.queryOutput).filter(o => typeof o !== 'string'), // filter out '[no-dependency]' etc.
  );

  /**
   * @param {string} pathStr ./packages/lea-tabs/lea-tabs.js
   * @param {string[]} pkgs ['packages/lea-tabs', ...]
   */
  function replaceToMonoRepoPath(pathStr, pkgs) {
    let result = pathStr;
    pkgs.some(({ path: p, name }) => {
      // for instance ./packages/lea-tabs/lea-tabs.js  starts with 'packages/lea-tabs'
      const normalizedP = `./${p}`;
      if (pathStr.startsWith(normalizedP)) {
        const localPath = pathStr.replace(normalizedP, ''); // 'lea-tabs.js'
        result = `${name}/${localPath}`; // 'lea-tabs/lea-tabs.js'
        return true;
      }
      return false;
    });
    return result;
  }

  if (monoPkgs) {
    queryOutputs.forEach(resultObj => {
      if (resultObj.variable) {
        resultObj.variable.paths.forEach(pathObj => {
          // eslint-disable-next-line no-param-reassign
          pathObj.to = replaceToMonoRepoPath(pathObj.to, monoPkgs);
        });
      }
      if (resultObj.tag) {
        resultObj.tag.paths.forEach(pathObj => {
          // eslint-disable-next-line no-param-reassign
          pathObj.to = replaceToMonoRepoPath(pathObj.to, monoPkgs);
        });
      }
    });
  }

  return queryOutputs;
}

async function launchProvidenceWithExtendDocs({
  referenceProjectPaths,
  prefixCfg,
  outputFolder,
  extensions,
  allowlist,
  allowlistReference,
  cwd = process.cwd(),
}) {
  const t0 = performance.now();

  const queryOutputs = await getExtendDocsResults({
    referenceProjectPaths,
    prefixCfg,
    extensions,
    allowlist,
    allowlistReference,
    cwd,
  });

  // Write results
  const outputFilePath = pathLib.join(outputFolder, 'providence-extend-docs-data.json');

  if (fs.existsSync(outputFilePath)) {
    fs.unlinkSync(outputFilePath);
  }
  fs.writeFile(outputFilePath, JSON.stringify(queryOutputs, null, 2), err => {
    if (err) {
      throw err;
    }
  });

  const t1 = performance.now();
  LogService.info(`"extend-docs" completed in ${Math.round((t1 - t0) / 1000)} seconds`);
}

module.exports = {
  launchProvidenceWithExtendDocs,
  getExtendDocsResults,
};
