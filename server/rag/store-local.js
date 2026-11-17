// Локальное хранилище знаний (D-134/D-137): реализация интерфейса
// KnowledgeStore без сети — для тестов и офлайн-режима. Та же логика
// гибридного поиска, что и в Supabase-реализации (search-core).
//
// Интерфейс KnowledgeStore:
//   upsert(entry, embedding?) -> Promise<void>
//   all() -> Promise<entry[]>           (с полем embedding, если есть)
//   search({query, queryEmbedding, filters, topK}) -> Promise<searchResult>
//   count() -> Promise<number>

import { hybridSearch } from './search-core.js';

export class LocalKnowledgeStore {
  constructor(entries = []) {
    this.byId = new Map();
    for (const e of entries) this.byId.set(e.id, { ...e });
  }

  async upsert(entry, embedding = null) {
    this.byId.set(entry.id, { ...entry, embedding });
  }

  async all() {
    return [...this.byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async count() {
    return this.byId.size;
  }

  async search({ query, queryEmbedding = null, filters = {}, topK = 3, minResults = 3 }) {
    return hybridSearch(await this.all(), { query, queryEmbedding, filters, topK, minResults });
  }
}