/**
 * VoiceScribe — IndexedDBストレージ管理モジュール (StorageManager)
 * 録音データ（Blob）およびメタデータの永続化・検索・削除を担当
 */

const DB_NAME = 'VoiceScribeDB';
const DB_VERSION = 1;
const STORE_NAME = 'recordings';

class StorageManager {
  constructor() {
    this.db = null;
  }

  /**
   * IndexedDBを初期化
   * @returns {Promise<void>}
   */
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('transcript', 'transcript', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        console.log('IndexedDB 初期化完了');
        this.requestPersist();
        resolve();
      };

      request.onerror = (event) => {
        console.error('IndexedDB 初期化エラー:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * 可能ならオリジンの保存を退避対象から外す。拒否されても録音は続ける。
   * @returns {Promise<boolean>}
   */
  requestPersist() {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : null;
    if (!storage || typeof storage.persist !== 'function') return Promise.resolve(false);
    return storage.persist().catch(() => false);
  }

  /**
   * 履歴1件。音声 Blob は IndexedDB、テキストは同じレコードの構造化フィールド。
   * transcript は既存画面用。text / durationMs / audioKey は再起動後も同じ意味で読める。
   * @param {Object} recording
   * @returns {Object}
   */
  static normalize(recording) {
    const source = recording || {};
    const fromTranscript = source.transcript != null ? String(source.transcript).trim() : '';
    const fromText = source.text != null ? String(source.text).trim() : '';
    const text = fromTranscript || fromText;
    const createdAt = source.createdAt || Date.now();
    const durationMs = Number.isFinite(source.durationMs)
      ? Math.max(0, Math.round(source.durationMs))
      : Math.max(0, Math.round((Number(source.duration) || 0) * 1000));
    const segments = Array.isArray(source.segments)
      ? source.segments.filter((blob) => blob && blob.size)
      : [];
    let audioBlob = source.audioBlob && source.audioBlob.size ? source.audioBlob : null;
    if (!audioBlob && segments.length === 1) audioBlob = segments[0];
    return Object.assign({}, source, {
      id: source.id,
      createdAt: createdAt,
      updatedAt: Date.now(),
      text: text,
      transcript: text,
      mimeType: source.mimeType || (audioBlob && audioBlob.type) || 'audio/mp4',
      duration: Math.round(durationMs / 1000),
      durationMs: durationMs,
      audioKey: source.audioKey || source.id,
      audioBlob: audioBlob,
      segments: segments.length > 1 ? segments : null,
      language: source.language || 'ja-JP',
      title: source.title || ''
    });
  }

  /**
   * 録音データを保存。request の success ではなく transaction の完了で返す。
   * iOS がページを殺す前に、コミットまで届いたかを呼び出し側が待ける。
   * @param {Object} recording
   * @returns {Promise<Object>}
   */
  async save(recording) {
    const record = StorageManager.normalize(recording);
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('データベースが初期化されていません'));
        return;
      }

      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(record);
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(record);
      };

      request.onerror = (event) => {
        console.error('データ保存エラー:', event.target.error);
        finish(event.target.error || new Error('データ保存エラー'));
      };
      tx.oncomplete = () => finish();
      tx.onabort = () => finish(tx.error || new Error('保存が確定しませんでした'));
      tx.onerror = () => finish(tx.error || new Error('保存に失敗しました'));
    });
  }

  /**
   * 全録音データを取得（新しい順）
   * @returns {Promise<Array>}
   */
  async getAll() {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        resolve([]);
        return;
      }

      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('createdAt');
      const request = index.getAll();

      request.onsuccess = (event) => {
        const results = (event.target.result || []).reverse();
        resolve(results);
      };

      request.onerror = (event) => {
        console.error('データ取得エラー:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * ID指定で録音データを取得
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async getById(id) {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        resolve(null);
        return;
      }

      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(id);

      request.onsuccess = (event) => resolve(event.target.result || null);
      request.onerror = (event) => {
        console.error('ID取得エラー:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * 録音データを削除
   * @param {string} id
   * @returns {Promise<void>}
   */
  async delete(id) {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('データベースが初期化されていません'));
        return;
      }

      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = (event) => {
        console.error('削除エラー:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * キーワードで検索
   * @param {string} query
   * @returns {Promise<Array>}
   */
  async search(query) {
    const all = await this.getAll();
    if (!query || !query.trim()) return all;

    const lowerQuery = query.toLowerCase().trim();
    return all.filter((rec) => {
      const titleMatch = rec.title && rec.title.toLowerCase().includes(lowerQuery);
      const body = rec.text || rec.transcript || '';
      const transcriptMatch = body.toLowerCase().includes(lowerQuery);
      return titleMatch || transcriptMatch;
    });
  }

  /**
   * ユニークIDを生成
   * @returns {string}
   */
  static generateId() {
    return `rec_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

// グローバルエクスポート
window.StorageManager = StorageManager;
