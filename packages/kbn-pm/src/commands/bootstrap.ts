/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import { resolve, sep } from 'path';
import { spawnStreaming } from '../utils/child_process';
import { linkProjectExecutables } from '../utils/link_project_executables';
import { getNonBazelProjectsOnly, topologicallyBatchProjects } from '../utils/projects';
import { ICommand } from './';
import { readYarnLock } from '../utils/yarn_lock';
import { validateDependencies } from '../utils/validate_dependencies';
import {
  ensureYarnIntegrityFileExists,
  installBazelTools,
  runBazel,
  yarnIntegrityFileExists,
} from '../utils/bazel';

export const BootstrapCommand: ICommand = {
  description: 'Install dependencies and crosslink projects',
  name: 'bootstrap',

  reportTiming: {
    group: 'bootstrap',
    id: 'overall time',
  },

  async run(projects, projectGraph, { options, kbn, rootPath }) {
    const nonBazelProjectsOnly = await getNonBazelProjectsOnly(projects);
    const batchedNonBazelProjects = topologicallyBatchProjects(nonBazelProjectsOnly, projectGraph);
    const kibanaProjectPath = projects.get('kibana')?.path || '';
    const runOffline = options?.offline === true;

    // Force install is set in case a flag is passed or
    // if the `.yarn-integrity` file is not found which
    // will be indicated by the return of yarnIntegrityFileExists.
    const forceInstall =
      (!!options && options['force-install'] === true) ||
      !(await yarnIntegrityFileExists(resolve(kibanaProjectPath, 'node_modules')));

    // Ensure we have a `node_modules/.yarn-integrity` file as we depend on it
    // for bazel to know it has to re-install the node_modules after a reset or a clean
    await ensureYarnIntegrityFileExists(resolve(kibanaProjectPath, 'node_modules'));

    // Install bazel machinery tools if needed
    await installBazelTools(rootPath);

    // Bootstrap process for Bazel packages
    // Bazel is now managing dependencies so yarn install
    // will happen as part of this
    //
    // NOTE: Bazel projects will be introduced incrementally
    // And should begin from the ones with none dependencies forward.
    // That way non bazel projects could depend on bazel projects but not the other way around
    // That is only intended during the migration process while non Bazel projects are not removed at all.
    //
    if (forceInstall) {
      await runBazel(['run', '@nodejs//:yarn'], runOffline);
    }

    await runBazel(['build', '//packages:build', '--show_result=1'], runOffline);

    // Install monorepo npm dependencies outside of the Bazel managed ones
    for (const batch of batchedNonBazelProjects) {
      for (const project of batch) {
        const isExternalPlugin = project.path.includes(`${kibanaProjectPath}${sep}plugins`);

        if (!project.hasDependencies()) {
          continue;
        }

        if (isExternalPlugin) {
          await project.installDependencies();
          continue;
        }

        if (
          !project.isSinglePackageJsonProject &&
          !project.isEveryDependencyLocal() &&
          !isExternalPlugin
        ) {
          throw new Error(
            `[${project.name}] is not eligible to hold non local dependencies. Move the non local dependencies into the top level package.json.`
          );
        }
      }
    }

    const yarnLock = await readYarnLock(kbn);

    if (options.validate) {
      await validateDependencies(kbn, yarnLock);
    }

    // Assure all kbn projects with bin defined scripts
    // copy those scripts into the top level node_modules folder
    //
    // NOTE: We don't probably need this anymore, is actually not being used
    await linkProjectExecutables(projects, projectGraph);

    // Update vscode settings
    await spawnStreaming(
      process.execPath,
      ['scripts/update_vscode_config'],
      {
        cwd: kbn.getAbsolute(),
        env: process.env,
      },
      { prefix: '[vscode]', debug: false }
    );

    // Build typescript references
    await spawnStreaming(
      process.execPath,
      ['scripts/build_ts_refs', '--ignore-type-failures', '--info'],
      {
        cwd: kbn.getAbsolute(),
        env: process.env,
      },
      { prefix: '[ts refs]', debug: false }
    );
  },
};
