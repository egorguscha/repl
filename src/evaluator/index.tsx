import React from 'react'
import * as pathLibrary from 'path'
import {combine, createEffect} from 'effector'
import {prepareRuntime} from './prepareRuntime'
import {selectVersion} from '../editor'
import {version, sourceCode, compiledCode} from '../editor/state'
import {typechecker} from '../settings/state'
// TODO: remove exact dependency on feature, use requirements in the future
import {consoleMap} from '~/features/logs'
import {realmStatusApi, realmListener, realmRemoveListener} from '../realm'
import {exec} from './runtime'
import {getStackFrames} from './stackframe/getStackFrames'
import PluginEffectorReact from 'effector/babel-plugin-react'
import PluginBigInt from '@babel/plugin-syntax-bigint'
import * as babel from '@babel/core'
import CodeMirror from 'codemirror'
import {generateBabelConfig} from './runtime'
import {availablePlugins} from '@babel/standalone'
import {codeMirror} from '~/editor/view'

const tag = `# source`
const filename = combine(typechecker, (typechecker): string => {
  if (typechecker === 'typescript') return 'repl.ts'
  return 'repl.js'
})

async function createRealm(sourceCode: string, filename, additionalLibs = {}) {
  const realm = {} as any
  realm.process = {env: {NODE_ENV: 'development'}}
  realm.require = path => {
    switch (path) {
      case 'symbol-observable':
        return (Symbol as any).observable || '@@observable'
      case 'path':
        return pathLibrary
      case 'react':
        return React
    }
    if (path in additionalLibs) return additionalLibs[path]
    console.warn('require: ', path)
  }
  realm.exports = {}
  realm.module = {exports: realm.exports}
  realm.console = consoleMap()
  await exec({
    code: `'use strict'; ${sourceCode}\n//${tag}URL=${filename}`,
    realmGlobal: getIframe().contentWindow,
    globalBlocks: [realm],
    onRuntimeError,
    compile: false,
    filename,
  })
  return realm.module.exports || realm.exports
}

const cache = {
  effector: new Map(),
  '@effector/babel-plugin': new Map(),
}

const fetchEffector = createEffect('fetch effector', {
  async handler(ver: string) {
    const url =
      ver === 'master'
        ? 'https://effector--canary.s3-eu-west-1.amazonaws.com/effector/effector.cjs.js'
        : `https://unpkg.com/effector@${ver}/effector.cjs.js`
    const sourceMap = `${url}.map`
    const req = await fetch(url)
    let text = await req.text()
    text = text.replace(
      /\/\/\# sourceMappingURL\=.*$/m,
      `//${tag}MappingURL=${sourceMap}`,
    )
    return createRealm(text, `effector.${ver}.js`)
  },
})

fetchEffector.fail.watch(() => selectVersion('master'))

const fetchBabelPlugin = createEffect<string, {[key: string]: any}, any>({
  async handler(ver) {
    let url: string
    if (ver === 'master') {
      url =
        'https://effector--canary.s3-eu-west-1.amazonaws.com/effector/babel-plugin.js'
    } else {
      let [major, minor = '', patch = ''] = ver.split('.')
      patch = patch.split('-')[0]
      if (
        major === '0' &&
        (parseInt(minor) < 18 || (minor === '18' && parseInt(patch) < 7))
      ) {
        url = `https://unpkg.com/@effector/babel-plugin@latest/index.js`
      } else {
        url = `https://unpkg.com/effector@${ver}/babel-plugin.js`
      }
    }
    const sourceMap = `${url}.map`
    const req = await fetch(url)
    let text = await req.text()
    text = text.replace(
      /\/\/\# sourceMappingURL\=.*$/m,
      `//${tag}MappingURL=${sourceMap}`,
    )
    return createRealm(text, `effector-babel-plugin.${ver}.js`)
  },
})

const fetchEffectorReact = createEffect<any, {[key: string]: any}, any>({
  async handler(effector) {
    const url =
      'https://effector--canary.s3-eu-west-1.amazonaws.com/effector-react/effector-react.cjs.js'
    const sourceMap = `${url}.map`
    const req = await fetch(url)
    let text = await req.text()
    text = text.replace(
      /\/\/\# sourceMappingURL\=.*$/m,
      `//${tag}MappingURL=${sourceMap}`,
    )
    return createRealm(text, `effector-react.cjs.js`, {effector})
  },
})

const fetchForest = createEffect({
  async handler(effector) {
    const url =
      'https://effector--canary.s3-eu-west-1.amazonaws.com/forest/forest.cjs.js'
    const sourceMap = `${url}.map`
    const req = await fetch(url)
    let text = await req.text()
    text = text.replace(
      /\/\/\# sourceMappingURL\=.*$/m,
      `//${tag}MappingURL=${sourceMap}`,
    )
    return createRealm(text, `forest.cjs.js`, {effector})
  },
})

const fetchEffectorReactSSR = createEffect({
  async handler(effector) {
    const url =
      'https://effector--canary.s3-eu-west-1.amazonaws.com/effector-react/scope.js'
    const sourceMap = `${url}.map`
    const req = await fetch(url)
    let text = await req.text()
    text = text.replace(
      /\/\/\# sourceMappingURL\=.*$/m,
      `//${tag}MappingURL=${sourceMap}`,
    )
    return createRealm(text, `scope.js`, {effector})
  },
})

const fetchPatronum = createEffect({
  async handler(effector) {
    const url = 'https://unpkg.com/patronum/patronum.cjs.js'
    const sourceMap = `${url}.map`
    const req = await fetch(url)
    let text = await req.text()
    text = text.replace(
      /\/\/\# sourceMappingURL\=.*$/m,
      `//${tag}MappingURL=${sourceMap}`,
    )
    return createRealm(text, `patronum.js`, {effector})
  },
})

fetchBabelPlugin.fail.watch(() => selectVersion('master'))

const api = {
  effector: fetchEffector,
  '@effector/babel-plugin': fetchBabelPlugin,
  forest: fetchForest,
}

function cacher(v, cache, fetcher) {
  const cached = cache.get(v)
  if (cached) return cached
  const req = fetcher(v)
  cache.set(v, req)
  return req
}

export const versionLoader = version.map(v => {
  const data = {}
  for (const key in cache) {
    data[key] = cacher(v, cache[key], api[key])
  }
  return data
})

export async function evaluator(code: string) {
  realmStatusApi.init()
  const [babelPlugin, effector] = await Promise.all([
    cache['@effector/babel-plugin'].get(version.getState()),
    cache.effector.get(version.getState()),
  ])
  const effectorReact = await fetchEffectorReact(effector)
  let forest
  let effectorReactSSR
  let patronum
  if (version.getState() === 'master') {
    const additionalLibs = await Promise.all([
      fetchForest(effector),
      fetchEffectorReactSSR(effector),
      fetchPatronum(effector),
    ])
    forest = additionalLibs[0]
    effectorReactSSR = additionalLibs[1]
    patronum = additionalLibs[2]
  }
  const env = prepareRuntime(effector, effectorReact, version.getState())
  return exec({
    code,
    realmGlobal: getIframe().contentWindow,
    globalBlocks: [
      env, {
        dom: forest, forest, effectorFork: effector, effectorReactSSR, patronum,
        CodeMirror, cm: codeMirror,
        babel,
        generateBabelConfig: (plugins = []) => {
          const config = generateBabelConfig({types: null, filename: 'file'})
          config.plugins = [
            "transform-strict-mode",
            "syntax-bigint",
            "proposal-numeric-separator",
            "proposal-nullish-coalescing-operator",
            "proposal-optional-chaining",
            "effector/babel-plugin-react",
            "@effector/repl-remove-imports",
            [availablePlugins['proposal-class-properties'], {loose: true}],
            [availablePlugins['effector/babel-plugin'], {addLoc: true}],
            availablePlugins['syntax-jsx'],
            ...plugins
          ].map((plugin) => typeof plugin === 'string' ? availablePlugins[plugin] : plugin)
          config.presets = []
          return config
        },
        availablePlugins,
      },
    ],
    filename: filename.getState(),
    types: typechecker.getState() || 'typescript',
    pluginRegistry: {
      'effector/babel-plugin': babelPlugin,
      'effector/babel-plugin-react': PluginEffectorReact,
      'syntax-bigint': PluginBigInt,
      '@effector/repl-remove-imports': removeImportsPlugin,
    },
    onCompileError(error) {
      realmStatusApi.fail()
      console.error('Babel ERR', error)
      throw {type: 'babel-error', original: error, stackFrames: []}
    },
    onRuntimeError,
    onCompileComplete(compiled, config) {
      compiledCode.setState(compiled)
    },
    onRuntimeComplete() {
      realmStatusApi.done()
    },
  })
}

const onRuntimeError = async error => {
  realmStatusApi.fail()
  console.error('Runtime ERR', error)
  const stackFrames = await getStackFrames(error)
  throw {type: 'runtime-error', original: error, stackFrames}
}
function replaceModuleImports(globalVarName, path, {types: t}) {
  const values = []
  for (const specifier of path.node.specifiers) {
    switch (specifier.type) {
      case 'ImportSpecifier':
        values.push(
          t.objectProperty(
            t.identifier(specifier.imported.name),
            t.identifier(specifier.local.name),
          ),
        )
        break
      case 'ImportNamespaceSpecifier':
      case 'ImportDefaultSpecifier':
        path.replaceWith(
          t.VariableDeclaration('const', [
            t.VariableDeclarator(
              t.identifier(specifier.local.name),
              t.memberExpression(
                t.identifier('globalThis'),
                t.identifier(globalVarName),
              ),
            ),
          ]),
        )
        return
    }
  }
  path.replaceWith(
    t.VariableDeclaration('const', [
      t.VariableDeclarator(
        t.objectPattern(values),
        t.memberExpression(
          t.identifier('globalThis'),
          t.identifier(globalVarName),
        ),
      ),
    ]),
  )
}
const removeImportsPlugin = babel => ({
  visitor: {
    ImportDeclaration(path) {
      switch (path.node.source.value) {
        case 'forest':
        case 'effector-dom':
          replaceModuleImports('forest', path, babel)
          break
        case 'effector/fork':
          replaceModuleImports('effectorFork', path, babel)
          break
        case 'effector-react/scope':
        case 'effector-react/ssr':
          replaceModuleImports('effectorReactSSR', path, babel)
          break
        case 'patronum':
          replaceModuleImports('patronum', path, babel)
          break
        default:
          // TODO: import actual module after patronum refactoring to ES Modules
          if (path.node.source.value.indexOf('patronum/') === 0) {
            replaceModuleImports('patronum', path, babel)
          } else path.remove()
      }
    },
    ExportDefaultDeclaration(path) {
      path.remove()
    },
    ExportNamedDeclaration(path) {
      if (path.node.declaration) {
        path.replaceWith(path.node.declaration)
      } else {
        path.remove()
      }
    },
  },
})

let iframe: HTMLIFrameElement | null = null

function getIframe(): HTMLIFrameElement {
  if (iframe === null) {
    iframe = document.getElementById('dom') || document.createElement('iframe')
    const wrapListenerMethods = target => {
      if (!target) return
      if (!target.addEventListener.__original__) {
        const originalMethod = target.addEventListener.bind(target)
        function addEventListener(type, fn, options) {
          originalMethod(type, fn, options)
          realmListener({type, target, fn, options})
        }
        addEventListener.__original__ = originalMethod
        target.addEventListener = addEventListener
      }
      if (!target.removeEventListener.__original__) {
        const originalMethod = target.removeEventListener.bind(target)
        function removeEventListener(type, fn, options) {
          originalMethod(type, fn, options)
          realmRemoveListener({type, target, fn, options})
        }
        removeEventListener.__original__ = originalMethod
        target.removeEventListener = removeEventListener
      }
    }
    const generateFrame = () => {
      if (iframe === null) return
      if (iframe.contentDocument.body === null) return
      resetHead(iframe.contentDocument)
      iframe.contentDocument.body.innerHTML =
        '<div class="spectrum spectrum--lightest spectrum--medium" id="root"></div>'
      //wrapListenerMethods(iframe.contentDocument)
      //wrapListenerMethods(iframe.contentWindow)
      //wrapListenerMethods(iframe.contentDocument.body)
      //wrapListenerMethods(iframe.contentDocument.documentElement)
    }
    sourceCode.watch(generateFrame)
    selectVersion.watch(generateFrame)
  }

  return iframe
}

function resetHead(document) {
  const styleLinks = [
    'https://unpkg.com/@adobe/spectrum-css@2.x/dist/spectrum-core.css',
    'https://unpkg.com/@adobe/spectrum-css@2.x/dist/spectrum-lightest.css',
  ]
  for (const node of document.head.childNodes) {
    if (node.nodeName === 'LINK') {
      const href = node.getAttribute('href')
      const rel = node.getAttribute('rel')
      if (rel === 'stylesheet' && styleLinks.includes(href)) {
        styleLinks.splice(styleLinks.indexOf(href), 1)
        continue
      }
    }
    node.remove()
  }
  for (const url of styleLinks) {
    const link = document.createElement('link')
    link.setAttribute('rel', 'stylesheet')
    link.setAttribute('href', url)
    document.head.appendChild(link)
  }
}
