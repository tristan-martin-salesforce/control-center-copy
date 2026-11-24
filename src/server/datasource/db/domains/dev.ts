/**
 * The db DataSource, dev domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import type { DbCtx } from '../ctx';
import { I, Res } from '../shared';
import { AppError } from '@/server/errors';

export class DbDev {
  constructor(private readonly ctx: DbCtx) {}

  private devOnly(): never {
    throw new AppError('not_found', 'Dev routes exist only in mock mode');
  }
  async getScenario(_i: I<'getScenario'>): Promise<Res<'getScenario'>> {
    return this.devOnly();
  }
  async controlScenario(_i: I<'controlScenario'>): Promise<Res<'controlScenario'>> {
    return this.devOnly();
  }
  async getDevFail(_i: I<'getDevFail'>): Promise<Res<'getDevFail'>> {
    return this.devOnly();
  }
  async setDevFail(_i: I<'setDevFail'>): Promise<Res<'setDevFail'>> {
    return this.devOnly();
  }
  async devEngineChange(_i: I<'devEngineChange'>): Promise<Res<'devEngineChange'>> {
    return this.devOnly();
  }
}
