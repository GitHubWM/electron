#!/usr/bin/env node

const { GitProcess } = require('dugite')
const utils = require('./lib/version-utils')
const plist = require('plist')
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const minimist = require('minimist')

const writeFile = promisify(fs.writeFile)
const readFile = promisify(fs.readFile)

function parseCommandLine () {
  let help
  const opts = minimist(process.argv.slice(2), {
    string: [ 'bump', 'version' ],
    boolean: [ 'stable', 'dryRun', 'help' ],
    alias: { 'version': ['v'] },
    unknown: arg => { help = true }
  })
  if (help || opts.help || !(opts.bump || opts.stable)) {
    console.log(`
      Bump version numbers. Must specify at least one of the three options:\n
        --bump=patch to increment patch version, or\n
        --stable to promote current beta to stable, or\n
        --version={version} to set version number directly\n
      Note that you can use both --bump and --stable 
      simultaneously.
    `)
    process.exit(0)
  }
  return opts
}

// run the script
async function main () {
  const opts = parseCommandLine()
  const version = await nextVersion(opts.bump)
  const versions = utils.parseVersion(version.split('-')[0])

  let suffix = ''
  if (version.includes('-')) {
    suffix = `-${version.split('-')[1]}`
    versions[3] = utils.parseVersion(version)[3]
  }

  if (opts.dryRun) {
    console.log(`new version number would be: ${version}\n`)
    return 0
  }

  // update all related files
  await Promise.all([
    updateVersion(version),
    updateInfoPlist(version),
    updatePackageJSON(version),
    tagVersion(version),
    updateVersionH(versions, suffix)
    // updateWinRC(version, versions, args.bump === 'nightly')
  ])

  console.log(`Bumped to version: ${version}`)
}

// get next version for release based on [nightly, beta, stable]
async function nextVersion (bumpType) {
  let version = await utils.getElectronVersion()
  if (utils.isNightly(version) || utils.isBeta(version)) {
    switch (bumpType) {
      case 'nightly':
        version = await utils.nextNightly(version)
        break
      case 'beta':
        version = await utils.nextBeta(version)
        break
      case 'stable':
        version = utils.nextStableFromPre(version)
        break
      default:
        throw new Error('Invalid bump type.')
    }
  } else if (utils.isStable(version)) {
    switch (bumpType) {
      case 'nightly':
        version = utils.nextNightly(version)
        break
      case 'beta':
        throw new Error('Cannot bump to beta from stable.')
      case 'stable':
        version = utils.nextStableFromStable(version)
        break
      default:
        throw new Error('Invalid bump type.')
    }
  } else {
    throw new Error(`Invalid current version: ${version}`)
  }
  return version
}

// update VERSION file with latest release info
async function updateVersion (version) {
  const versionPath = path.resolve(__dirname, '..', 'VERSION')
  await writeFile(versionPath, version, 'utf8')
}

// update package metadata files with new version
async function updatePackageJSON (version) {
  ['package.json', 'package-lock.json'].forEach(async fileName => {
    const filePath = path.resolve(__dirname, '..', fileName)
    const file = require(filePath)
    file.version = version
    await writeFile(filePath, JSON.stringify(file, null, 2))
  })
}

// update CFBundle version information and overwrite pre-existing file
async function updateInfoPlist (version) {
  const filePath = path.resolve(__dirname, '..', 'atom', 'browser', 'resources', 'mac', 'Info.plist')
  const xml = plist.parse(await readFile(filePath, { encoding: 'utf8' }))
  const file = JSON.parse(JSON.stringify(xml))

  file.CFBundleVersion = version
  file.CFBundleShortVersionString = version

  const outFile = plist.build(file)
  await writeFile(filePath, outFile)
}

// push bump commit to release branch
async function tagVersion (version) {
  const gitDir = path.resolve(__dirname, '..')
  const gitArgs = ['commit', '-a', '-m', `Bump v${version}`, '-n']
  await GitProcess.exec(gitArgs, gitDir)
}

// updates atom_version.h file with new semver values
async function updateVersionH (parts, suffix) {
  const filePath = path.resolve(__dirname, '..', 'atom', 'common', 'atom_version.h')
  const data = await readFile(filePath, { encoding: 'utf8' })
  const arr = data.split('\n')
  arr.forEach((item, idx) => {
    if (item.includes('#define ATOM_MAJOR_VERSION')) {
      item = `#define ATOM_MAJOR_VERSION ${parts[0]}`
      arr[idx + 1] = `#define ATOM_MINOR_VERSION ${parts[1]}`
      arr[idx + 2] = `#define ATOM_PATCH_VERSION ${parts[2]}`

      if (suffix) {
        arr[idx + 4] = `#define ATOM_PRE_RELEASE_VERSION ${suffix}`
      } else {
        arr[idx + 4] = `// #define ATOM_PRE_RELEASE_VERSION`
      }
    }
  })
  await writeFile(filePath, arr.join('\n'))
}

// TODO(codebytere): implement
function updateWinRC (version, parts) {
  const isNightly = utils.isNightly(version)
  const filePath = path.resolve(__dirname, '..', 'atom', 'browser', 'resources', 'win', 'atom.rc')
  // parse and update the atom.rc file
}

if (process.mainModule === module) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
