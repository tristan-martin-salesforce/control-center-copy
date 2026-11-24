/** Dev (mock only; the db implementation throws not_found). */
import type { In, Out } from './route';

export interface DevSource {
  getScenario(i: In<'getScenario'>): Out<'getScenario'>;
  controlScenario(i: In<'controlScenario'>): Out<'controlScenario'>;
  getDevFail(i: In<'getDevFail'>): Out<'getDevFail'>;
  setDevFail(i: In<'setDevFail'>): Out<'setDevFail'>;
  devEngineChange(i: In<'devEngineChange'>): Out<'devEngineChange'>;
}
