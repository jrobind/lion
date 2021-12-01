const pathLib = require('path');
const { expect } = require('chai');
const cliHelpersModule = require('../../src/cli/cli-helpers.js');

const { appendProjectDependencyPaths } = cliHelpersModule;

/**
 * These tests are added on top of unit tests. See:
 * - https://github.com/ing-bank/lion/issues/1565
 * - https://github.com/ing-bank/lion/issues/1564
 */
describe('CLI helpers against filesystem', () => {
  describe('appendProjectDependencyPaths', () => {
    it('allows a regex filter', async () => {
      const targetFilePath = pathLib.resolve(
        __dirname,
        '../../test-helpers/project-mocks/importing-target-project',
      );
      const result = await appendProjectDependencyPaths([targetFilePath], '/^dep-/');
      expect(result).to.eql([
        `${targetFilePath}/node_modules/dep-a`,
        // in windows, it should not add `${targetFilePath}/node_modules/my-dep-b`,
        targetFilePath,
      ]);
    });
  });
});
