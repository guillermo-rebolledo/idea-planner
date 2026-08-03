import { describe, expect, it } from 'vitest'
import { detectEditors, openCommand } from './editors'

/** A Mac that has exactly these bundles installed. */
function machineWith(...bundles: string[]) {
  return (path: string): Promise<boolean> =>
    Promise.resolve(bundles.some((bundle) => path.endsWith(`/${bundle}`)))
}

describe('detecting editors', () => {
  it('offers a detected editor, then the two the system always has', async () => {
    const editors = await detectEditors({
      applicationDirs: ['/Applications'],
      exists: machineWith('Cursor.app')
    })

    expect(editors).toEqual([
      { id: 'cursor', name: 'Cursor' },
      { id: 'terminal', name: 'Terminal' },
      { id: 'finder', name: 'Finder' }
    ])
  })

  it('keeps a fixed order however many are installed', async () => {
    const editors = await detectEditors({
      applicationDirs: ['/Applications'],
      exists: machineWith('Zed.app', 'Visual Studio Code.app', 'Cursor.app')
    })

    expect(editors.map((editor) => editor.id)).toEqual([
      'cursor',
      'vscode',
      'zed',
      'terminal',
      'finder'
    ])
  })

  it('finds an editor installed only for this user', async () => {
    const editors = await detectEditors({
      applicationDirs: ['/Applications', '/Users/someone/Applications'],
      exists: (path) => Promise.resolve(path === '/Users/someone/Applications/Zed.app')
    })

    expect(editors.map((editor) => editor.id)).toEqual(['zed', 'terminal', 'finder'])
  })

  it('lists an editor once even when it is installed twice', async () => {
    const editors = await detectEditors({
      applicationDirs: ['/Applications', '/Users/someone/Applications'],
      exists: machineWith('Cursor.app')
    })

    expect(editors.filter((editor) => editor.id === 'cursor')).toHaveLength(1)
  })

  it('still offers Terminal and Finder on a Mac with no editor at all', async () => {
    const editors = await detectEditors({
      applicationDirs: ['/Applications'],
      exists: () => Promise.resolve(false)
    })

    expect(editors.map((editor) => editor.id)).toEqual(['terminal', 'finder'])
  })
})

describe('what "Open in" actually runs', () => {
  it('addresses an application by the name it registered', () => {
    expect(openCommand('cursor', '/dev/weather-app')).toEqual({
      command: 'open',
      args: ['-a', 'Cursor', '/dev/weather-app']
    })
    expect(openCommand('vscode', '/dev/weather-app')).toEqual({
      command: 'open',
      args: ['-a', 'Visual Studio Code', '/dev/weather-app']
    })
    expect(openCommand('terminal', '/dev/weather-app')).toEqual({
      command: 'open',
      args: ['-a', 'Terminal', '/dev/weather-app']
    })
  })

  it('hands Finder the folder itself, which is how a folder is shown', () => {
    expect(openCommand('finder', '/dev/weather-app')).toEqual({
      command: 'open',
      args: ['/dev/weather-app']
    })
  })
})
