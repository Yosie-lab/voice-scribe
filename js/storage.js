/**
 * VoiceScribe — IndexedDBストレージ管理
 * 録音データ（Blob）とメタデータの永続化を担当
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
          // 日時でソートするためのインデックス
          store.createIndex('createdAt', 'createdAt', { unique: false });
          // 検索用テキストインデックス
          store.createIndex('transcript', 'transcript', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        console.log('IndexedDB 初期化完了');
        resolve();
      };

      request.onerror = (event) => {
        console.error('IndexedDB エラー:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * 録音データを保存
   * @param {Object} recording - 録音データオブジェクト
   * @param {string} recording.id - ユニークID
   * @param {Blob} recording.audioBlob - 録音された音声データ
   * @param {string} recording.mimeType - 音声のMIMEタイプ
   * @param {string} recording.transcript - 文字起こしテキスト
   * @param {string} recording.language - 録音時の言語
   * @param {number} recording.duration - 録音時間（秒）
   * @param {number} recording.createdAt - 作成日時（タイムスタンプ）
   * @returns {Promise<void>}
   */
  async save(recording) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(recording);

      request.onsuccess = () => resolve();
      request.onerror = (event) => {
        console.error('保存エラー:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * 全録音データを取得（新しい順にソート）
   * @returns {Promise<Array>}
   */
  async getAll() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('createdAt');
      const request = index.getAll();

      request.onsuccess = (event) => {
        // 新しい順にソート
        const results = event.target.result.reverse();
        resolve(results);
      };

      request.onerror = (event) => {
        console.error('取得エラー:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * 指定IDの録音データを取得
   * @param {string} id - 録音ID
   * @returns {Promise<Object|null>}
   */
  async getById(id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(id);

      request.onsuccess = (event) => resolve(event.target.result || null);
      request.onerror = (event) => {
        console.error('取得エラー:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * 録音データを更新（文字起こしテキストの編集など）
   * @param {string} id - 録音ID
   * @param {Object} updates - 更新するフィールド
   * @returns {Promise<void>}
   */
  async update(id, updates) {
    const recording = await this.getById(id);
    if (!recording) throw new Error(`録音データが見つかりません: ${id}`);

    const updated = { ...recording, ...updates };
    return this.save(updated);
  }

  /**
   * 録音データを削除
   * @param {string} id - 録音ID
   * @returns {Promise<void>}
   */
  async delete(id) {
    return new Promise((resolve, reject) => {
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
   * テキスト検索（文字起こしテキストの部分一致）
   * @param {string} query - 検索クエリ
   * @returns {Promise<Array>}
   */
  async search(query) {
    const all = await this.getAll();
    if (!query || query.trim() === '') return all;

    const lowerQuery = query.toLowerCase();
    return all.filter((recording) => {
      return (
        (recording.transcript && recording.transcript.toLowerCase().includes(lowerQuery)) ||
        (recording.title && recording.title.toLowerCase().includes(lowerQuery))
      );
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
