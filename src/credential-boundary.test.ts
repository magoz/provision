import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from '@effect/vitest'

// Factory admin credentials must stay out of the per-checkout commands: `env`, `db`, and the
// shared modules they use never import factory code, directly or via a relative path.
const sourceRoot = import.meta.dirname
const factoryRoot = join(sourceRoot, 'factory')
const guardedRoots = ['env', 'db', 'shared'].map(name => join(sourceRoot, name))

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.ts'))
    .map(file => join(directory, file))

const listGuardedFiles = () =>
  guardedRoots.flatMap(root => {
    try {
      return sourceFiles(root)
    } catch {
      return []
    }
  })

const importPattern =
  /(?:import|export)[^'"]*from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g

const factoryImports = (file: string) =>
  Array.from(readFileSync(file, 'utf8').matchAll(importPattern))
    .map(match => match[1] ?? match[2])
    .filter(specifier => specifier !== undefined)
    .map(specifier => resolve(dirname(file), specifier))
    .filter(target => target === factoryRoot || target.startsWith(`${factoryRoot}${sep}`))

describe('credential boundary', () => {
  it('keeps env, db, and shared modules independent of factory code', () => {
    const violations = listGuardedFiles().flatMap(file =>
      factoryImports(file).map(
        target => `${relative(sourceRoot, file)} -> ${relative(sourceRoot, target)}`
      )
    )

    expect(violations).toEqual([])
  })
})
