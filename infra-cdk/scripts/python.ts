// Locates a Python interpreter that can run the ML tooling (needs PyTorch).
//
// Why not just `python`? On Windows the first `python` on PATH is often the Microsoft Store
// "App execution alias" stub (...\WindowsApps\python.exe), which exists but is not an interpreter
// ("The system cannot find the file ...WindowsApps\python.exe"). So try, in order: $PYTHON, the
// `py` launcher, python, python3, and the python.org/Python-manager install location.
import { spawnSync, SpawnSyncReturns } from 'node:child_process';
import * as path from 'node:path';

export interface PythonCommand {
  cmd: string;
  args: string[];
  /** Absolute path the interpreter reports, for messages. */
  executable?: string;
}

export type Runner = (cmd: string, args: string[]) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'error'>;

const defaultRunner: Runner = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000 });

export function candidates(env: NodeJS.ProcessEnv = process.env): PythonCommand[] {
  const list: PythonCommand[] = [];
  if (env.PYTHON) list.push({ cmd: env.PYTHON, args: [] });
  list.push({ cmd: 'py', args: ['-3'] }, { cmd: 'python', args: [] }, { cmd: 'python3', args: [] });
  if (env.LOCALAPPDATA) {
    list.push({ cmd: path.join(env.LOCALAPPDATA, 'Python', 'bin', 'python.exe'), args: [] });
  }
  return list;
}

/** The first candidate that starts AND can import torch, or undefined. Never throws. */
export function findPython(run: Runner = defaultRunner, env: NodeJS.ProcessEnv = process.env): PythonCommand | undefined {
  for (const c of candidates(env)) {
    const r = run(c.cmd, [...c.args, '-c', 'import sys, torch; print(sys.executable)']);
    if (!r.error && r.status === 0 && r.stdout?.trim()) {
      return { ...c, executable: r.stdout.trim().split(/\r?\n/).pop() };
    }
  }
  return undefined;
}

export const NO_PYTHON_MESSAGE =
  'No Python with PyTorch was found. Tried $PYTHON, `py -3`, `python`, `python3` and %LOCALAPPDATA%\\Python\\bin. ' +
  'On Windows, `python` may be the Microsoft Store stub: install Python, `pip install -r src/ml-engine/requirements.txt`, ' +
  'or set the PYTHON environment variable to a python.exe that has torch.';
