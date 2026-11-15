import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'deploy',
      description: 'Upload site/ to the live server via deploy.sh',
    })
    return next(e)
  })

  on('command.run', { command: 'deploy' }, async $ => {
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe'
    const { exitCode, stdout, stderr } = await $.process.run([bash, '--login', 'deploy.sh'])
    const out = (stdout + stderr).trim()
    if (exitCode !== 0) return { text: `Deploy failed (exit ${exitCode}):\n${out}` }
    return { text: out || 'Done.' }
  })
}
