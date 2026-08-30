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
        resolve();
      };

      request.onerror = (event) => {
        console.error('IndexedDB 初期化エラー:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * 録音データを保存
   * @param {Object} recording
   * @param {string} recording.id
   * @param {Blob|null} recording.audioBlob
   * @param {string} recording.mimeType
   * @param {string} recording.transcript
   * @param {string} recording.language
   * @param {number} recording.duration
   * @param {number} recording.createdAt
   * @returns {Promise<void>}
   */
  async save(recording) {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('データベースが初期化されていません'));
        return;
      }

      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(recording);

      request.onsuccess = () => resolve();
      request.onerror = (event) => {
        console.error('データ保存エラー:', event.target.error);
        reject(event.target.error);
      };
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
      const transcriptMatch = rec.transcript && rec.transcript.toLowerCase().includes(lowerQuery);
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
