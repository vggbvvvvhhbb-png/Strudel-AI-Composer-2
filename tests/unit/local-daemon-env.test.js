import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const daemonUrl = new URL('../../local/daemon.mjs', import.meta.url).href;

it('loads an ignored environment file for daemon startup without exposing its token', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daemon-env-'));
  const token = 'fixture-local-token';
  const envPath = path.join(dir, '.env');
  await writeFile(envPath, `LOCAL_DAEMON_TOKEN=${token}\n`);
  const env = { ...process.env, DOTENV_CONFIG_PATH: envPath, LOCAL_DAEMON_ALLOW_ANON: '0', TEST_STATE_DIR: dir };
  delete env.LOCAL_DAEMON_TOKEN;
  try {
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `
      import {createDaemon} from ${JSON.stringify(daemonUrl)};
      const daemon=await createDaemon({stateDir:process.env.TEST_STATE_DIR,log:()=>{},analysisProbe:async()=>({available:false})});
      await new Promise(resolve=>daemon.server.listen(0,'127.0.0.1',resolve));
      const url='http://127.0.0.1:'+daemon.server.address().port+'/health';
      const unauthenticated=(await fetch(url)).status;
      const authenticated=(await fetch(url,{headers:{authorization:'Bearer '+process.env.LOCAL_DAEMON_TOKEN}})).status;
      console.log(JSON.stringify({authenticated,unauthenticated}));
      await new Promise(resolve=>daemon.server.close(resolve));
    `], { env, timeout: 15_000 });
    expect(JSON.parse(stdout)).toEqual({ authenticated: 200, unauthenticated: 401 });
    expect(stdout).not.toContain(token);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
