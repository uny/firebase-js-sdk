/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { spawn, exec } from 'child-process-promise';
import ora from 'ora';
import { createPromptModule } from 'inquirer';
import { projectRoot, readPackageJson } from '../utils';
import simpleGit from 'simple-git/promise';

import { mapWorkspaceToPackages } from '../release/utils/workspace';
import { inc } from 'semver';
import { writeFile as _writeFile, rmdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { promisify } from 'util';
import chalk from 'chalk';
import Listr from 'listr';
import { prepare as prepareFirestoreForRelease } from './prepare-firestore-for-exp-release';
import * as yargs from 'yargs';

const prompt = createPromptModule();
const argv = yargs
  .options({
    dryRun: {
      type: 'boolean',
      default: false
    }
  })
  .help().argv;

const writeFile = promisify(_writeFile);
const git = simpleGit(projectRoot);
const FIREBASE_UMBRELLA_PACKAGE_NAME = 'firebase-exp';

async function publishExpPackages({ dryRun }: { dryRun: boolean }) {
  try {
    /**
     * Welcome to the firebase release CLI!
     */
    console.log(
      `Welcome to the Firebase Exp Packages release CLI! dryRun: ${dryRun}`
    );

    /**
     * Update fields in package.json and stuff
     */
    await prepareFirestoreForRelease();

    /**
     * build packages
     */
    await buildPackages();

    // path to exp packages
    let packagePaths = await mapWorkspaceToPackages([
      `${projectRoot}/packages-exp/*`
    ]);

    packagePaths.push(`${projectRoot}/packages/firestore`);

    /**
     * It does 2 things:
     *
     * 1. Bumps the patch version of firebase-exp package regardless if there is any update
     * since the last release. This simplifies the script and works fine for exp packages.
     *
     * 2. Removes -exp in package names because we will publish them using
     * the existing package names under a special release tag (firebase@exp).
     */
    const versions = await updatePackageNamesAndVersions(packagePaths);

    let versionCheckMessage =
      '\r\nAre you sure these are the versions you want to publish?\r\n';
    for (const [pkgName, version] of versions) {
      versionCheckMessage += `${pkgName} : ${version}\n`;
    }
    const { versionCheck } = await prompt([
      {
        type: 'confirm',
        name: 'versionCheck',
        message: versionCheckMessage,
        default: false
      }
    ]);

    if (!versionCheck) {
      throw new Error('Version check failed');
    }

    /**
     * Release packages to NPM
     */
    await publishToNpm(packagePaths, dryRun);

    /**
     * reset the working tree to recover package names with -exp in the package.json files,
     * then bump patch version of firebase-exp (the umbrella package) only
     */
    const firebaseExpVersion = new Map<string, string>();
    firebaseExpVersion.set(
      FIREBASE_UMBRELLA_PACKAGE_NAME,
      versions.get(FIREBASE_UMBRELLA_PACKAGE_NAME)
    );
    const firebaseExpPath = packagePaths.filter(p =>
      p.includes(FIREBASE_UMBRELLA_PACKAGE_NAME)
    );

    const { resetWorkingTree } = await prompt([
      {
        type: 'confirm',
        name: 'resetWorkingTree',
        message: 'Do you want to reset the working tree?',
        default: true
      }
    ]);

    if (resetWorkingTree) {
      await resetWorkingTreeAndBumpVersions(
        firebaseExpPath,
        firebaseExpVersion
      );
    } else {
      process.exit(0);
    }

    /**
     * Do not push to remote if it's a dryrun
     */
    if (!dryRun) {
      const { commitAndPush } = await prompt([
        {
          type: 'confirm',
          name: 'commitAndPush',
          message:
            'Do you want to commit and push the exp version update to remote?',
          default: true
        }
      ]);
      /**
       * push to github
       */
      if (commitAndPush) {
        await commitAndPush(versions);
      }
    }
  } catch (err) {
    /**
     * Log any errors that happened during the process
     */
    console.error(err);

    /**
     * Exit with an error code
     */
    process.exit(1);
  }
}

/**
 * The order of build is important
 */
async function buildPackages() {
  const spinner = ora(' Building Packages').start();

  // Build dependencies
  await spawn(
    'yarn',
    [
      'lerna',
      'run',
      '--scope',
      // We replace `@firebase/app-exp` with `@firebase/app` during compilation, so we need to
      // compile @firebase/app first to make rollup happy though it's not an actual dependency.
      '@firebase/app',
      '--scope',
      // the same reason above
      '@firebase/functions',
      '--scope',
      // the same reason above
      '@firebase/remote-config',
      '--scope',
      '@firebase/util',
      '--scope',
      '@firebase/component',
      '--scope',
      '@firebase/logger',
      '--scope',
      '@firebase/webchannel-wrapper',
      'build'
    ],
    {
      cwd: projectRoot,
      stdio: 'inherit'
    }
  );

  // Build exp and compat packages except for firebase-exp
  await spawn(
    'yarn',
    [
      'lerna',
      'run',
      '--scope',
      '@firebase/*-exp',
      '--scope',
      '@firebase/*-compat',
      'build:release'
    ],
    {
      cwd: projectRoot,
      stdio: 'inherit'
    }
  );

  // Build exp packages developed in place
  // Firestore
  await spawn(
    'yarn',
    ['lerna', 'run', '--scope', '@firebase/firestore', 'prebuild'],
    {
      cwd: projectRoot,
      stdio: 'inherit'
    }
  );

  await spawn(
    'yarn',
    ['lerna', 'run', '--scope', '@firebase/firestore', 'build:exp:release'],
    {
      cwd: projectRoot,
      stdio: 'inherit'
    }
  );

  // remove packages/installations/dist, otherwise packages that depend on packages-exp/installations-exp (e.g. Perf, FCM)
  // will incorrectly reference packages/installations.
  const installationsDistDirPath = resolve(
    projectRoot,
    'packages/installations/dist'
  );
  if (existsSync(installationsDistDirPath)) {
    rmdirSync(installationsDistDirPath, { recursive: true });
  }

  // Build firebase-exp
  await spawn(
    'yarn',
    ['lerna', 'run', '--scope', 'firebase-exp', 'build:release'],
    {
      cwd: projectRoot,
      stdio: 'inherit'
    }
  );

  spinner.stopAndPersist({
    symbol: '✅'
  });
}

async function updatePackageNamesAndVersions(packagePaths: string[]) {
  // get package name -> next version mapping
  const versions = new Map();
  for (const path of packagePaths) {
    const { version, name } = await readPackageJson(path);

    // increment firebase-exp's patch version
    if (name === FIREBASE_UMBRELLA_PACKAGE_NAME) {
      const nextVersion = inc(version, 'patch');
      versions.set(name, nextVersion);
    } else {
      // create individual packages version
      // we can't use minor version for them because most of them
      // are still in the pre-major version officially.
      const nextVersion = `${version}-exp.${await getCurrentSha()}`;
      versions.set(name, nextVersion);
    }
  }

  await updatePackageJsons(packagePaths, versions, {
    removeExpInName: true,
    updateVersions: true,
    makePublic: true
  });

  return versions;
}

async function publishToNpm(packagePaths: string[], dryRun = false) {
  const taskArray = await Promise.all(
    packagePaths.map(async pp => {
      const { version, name } = await readPackageJson(pp);
      return {
        title: `📦  ${name}@${version}`,
        task: () => publishPackage(pp, dryRun)
      };
    })
  );

  const tasks = new Listr(taskArray, {
    concurrent: false,
    exitOnError: false
  });

  console.log('\r\nPublishing Packages to NPM:');
  return tasks.run();
}

async function publishPackage(packagePath: string, dryRun: boolean) {
  const args = ['publish', '--access', 'public', '--tag', 'exp'];
  if (dryRun) {
    args.push('--dry-run');
  }
  await spawn('npm', args, { cwd: packagePath });
}

async function resetWorkingTreeAndBumpVersions(
  packagePaths: string[],
  versions: Map<string, string>
) {
  console.log('Resetting working tree');
  await git.checkout('.');

  await updatePackageJsons(packagePaths, versions, {
    removeExpInName: false,
    updateVersions: true,
    makePublic: false
  });
}

async function updatePackageJsons(
  packagePaths: string[],
  versions: Map<string, string>,
  {
    removeExpInName,
    updateVersions,
    makePublic
  }: {
    removeExpInName: boolean;
    updateVersions: boolean;
    makePublic: boolean;
  }
) {
  for (const path of packagePaths) {
    const packageJsonPath = `${path}/package.json`;
    const packageJson = await readPackageJson(path);

    // update version
    if (updateVersions) {
      const nextVersion = versions.get(packageJson.name);
      console.log(
        chalk`Updating {blue ${packageJson.name}} from {green ${packageJson.version}} to {green ${nextVersion}}`
      );
      packageJson.version = nextVersion;
    }

    // remove -exp in the package name
    if (removeExpInName) {
      const cleanName = removeExpInPackageName(packageJson.name);
      console.log(
        chalk`Renaming {blue ${packageJson.name}} to {blue ${cleanName}}`
      );
      packageJson.name = cleanName;

      // update dep version and remove -exp in dep names
      // don't care about devDependencies because they are irrelavant when using the package
      const depTypes = ['dependencies', 'peerDependencies'];

      for (const depType of depTypes) {
        const dependencies = packageJson[depType] || {};
        const newDependenciesObj: { [key: string]: string } = {};
        for (const d of Object.keys(dependencies)) {
          const dNextVersion = versions.get(d);
          const nameWithoutExp = removeExpInPackageName(d);
          if (!dNextVersion) {
            newDependenciesObj[nameWithoutExp] = dependencies[d];
          } else {
            newDependenciesObj[nameWithoutExp] = dNextVersion;
          }
        }
        packageJson[depType] = newDependenciesObj;
      }
    }

    // set private to false
    if (makePublic) {
      packageJson.private = false;
    }

    // update package.json files
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(packageJson, null, 2)}\n`,
      { encoding: 'utf-8' }
    );
  }
}

async function commitAndPush(versions: Map<string, string>) {
  await exec('git add */package.json yarn.lock');

  const firebaseExpVersion = versions.get(FIREBASE_UMBRELLA_PACKAGE_NAME);
  await exec(
    `git commit -m "Publish firebase@exp ${firebaseExpVersion || ''}"`
  );

  let { stdout: currentBranch, stderr } = await exec(
    `git rev-parse --abbrev-ref HEAD`
  );
  currentBranch = currentBranch.trim();

  await exec(`git push origin ${currentBranch} --no-verify -u`, {
    cwd: projectRoot
  });
}

function removeExpInPackageName(name: string) {
  const regex = /^(.*firebase.*)-exp(.*)$/g;

  const captures = regex.exec(name);
  if (!captures) {
    return name;
  }

  return `${captures[1]}${captures[2]}`;
}

async function getCurrentSha() {
  return (await git.revparse(['--short', 'HEAD'])).trim();
}

publishExpPackages(argv);
