import { candidates, findPython, Runner } from '../scripts/python';

const ok = (executable: string) => ({ status: 0, stdout: `${executable}\n`, error: undefined });
const failed = { status: 9009, stdout: '', error: undefined };

describe('findPython', () => {
  test('skips the Microsoft Store stub and picks the first interpreter that has torch', () => {
    const tried: string[] = [];
    const run: Runner = (cmd, args) => {
      tried.push(`${cmd} ${args.join(' ')}`.trim());
      if (cmd.includes('WindowsApps')) return failed;
      if (cmd === 'python') return failed; // resolves to the stub
      if (cmd === 'py') return ok('C:\\Python314\\python.exe');
      return failed;
    };
    const found = findPython(run, { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' });
    expect(found).toMatchObject({ cmd: 'py', args: ['-3'], executable: 'C:\\Python314\\python.exe' });
    expect(tried[0]).toMatch(/^py -3/);
  });

  test('an interpreter without torch is skipped (it exits non-zero on the import)', () => {
    const run: Runner = (cmd) => (cmd === 'python3' ? ok('/usr/bin/python3') : { status: 1, stdout: '', error: undefined });
    expect(findPython(run, {})?.cmd).toBe('python3');
  });

  test('a command that cannot be spawned is skipped, not thrown', () => {
    const run: Runner = (cmd) =>
      cmd === 'python' ? ok('/usr/bin/python') : { status: null, stdout: '', error: new Error('ENOENT') };
    expect(findPython(run, {})?.cmd).toBe('python');
  });

  test('$PYTHON is tried first', () => {
    const run: Runner = (cmd) => (cmd === 'D:\\venv\\python.exe' ? ok('D:\\venv\\python.exe') : failed);
    expect(findPython(run, { PYTHON: 'D:\\venv\\python.exe' })?.cmd).toBe('D:\\venv\\python.exe');
    expect(candidates({ PYTHON: 'x' })[0].cmd).toBe('x');
  });

  test('returns undefined when nothing works', () => {
    expect(findPython(() => failed, {})).toBeUndefined();
  });
});
