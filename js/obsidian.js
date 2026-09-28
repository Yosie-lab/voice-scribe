/**
 * VoiceScribe — Obsidian Inbox 保存
 * obsidian://new で Vault の Inbox に Markdown を作る。
 * URL が長いときはクリップボード + 短いノート + .md の共有シート。
 */

class ObsidianInbox {
  static LS_VAULT = 'voicescribe.obsidian.vault';
  static LS_FOLDER = 'voicescribe.obsidian.folder';
  static URL_LIMIT = 1800;

  static getVault() {
    return ObsidianInbox._read(ObsidianInbox.LS_VAULT, 'Vault');
  }

  static getFolder() {
    return ObsidianInbox.sanitizeFolder(ObsidianInbox._read(ObsidianInbox.LS_FOLDER, '01_Inbox'));
  }

  static setVault(value) {
    ObsidianInbox._write(ObsidianInbox.LS_VAULT, (value || '').trim() || 'Vault');
  }

  static setFolder(value) {
    ObsidianInbox._write(ObsidianInbox.LS_FOLDER, ObsidianInbox.sanitizeFolder(value));
  }

  /**
   * @param {{ title?: string, transcript: string, language?: string, createdAt?: number }} note
   * @returns {Promise<{ ok: boolean, mode: 'uri'|'fallback', filePath: string, message: string }>}
   */
  static async save(note) {
    const transcript = (note.transcript || '').trim();
    if (!transcript) {
      return { ok: false, mode: 'uri', filePath: '', message: '保存する文字起こしがありません' };
    }

    const vault = ObsidianInbox.getVault();
    const folder = ObsidianInbox.getFolder();
    const title = ObsidianInbox.sanitizeTitle(note.title);
    const when = note.createdAt ? new Date(note.createdAt) : new Date();
    const name = ObsidianInbox.stampName(title, when);
    const filePath = `${folder}/${name}`;
    const md = ObsidianInbox.buildMarkdown({
      title,
      transcript,
      language: note.language,
      createdAt: when
    });

    const url = ObsidianInbox.buildNewUrl(vault, filePath, md);
    if (url.length > ObsidianInbox.URL_LIMIT) {
      await ObsidianInbox.fallbackLong(md, name, vault, filePath);
      return {
        ok: true,
        mode: 'fallback',
        filePath,
        message: '文章が長いので本文をコピーしました。Obsidianのノートに貼り付けてください'
      };
    }

    window.location.href = url;
    return {
      ok: true,
      mode: 'uri',
      filePath,
      message: `Obsidianに送信しました: ${filePath}.md`
    };
  }

  static buildNewUrl(vault, filePath, content) {
    return 'obsidian://new?vault=' + encodeURIComponent(vault) +
      '&file=' + encodeURIComponent(filePath) +
      '&content=' + encodeURIComponent(content);
  }

  static buildMarkdown({ title, transcript, language, createdAt }) {
    const safeTitle = ObsidianInbox.sanitizeTitle(title).replace(/"/g, "'");
    const when = createdAt instanceof Date ? createdAt : new Date(createdAt || Date.now());
    const lang = language === 'en-US' || language === 'en' ? 'en' : 'ja';
    return [
      '---',
      `title: "${safeTitle}"`,
      `date: ${when.toISOString().slice(0, 10)}`,
      `created: ${when.toISOString()}`,
      'tags:',
      '  - voice',
      '  - transcript',
      'source: voicescribe',
      `language: ${lang}`,
      '---',
      '',
      `# ${safeTitle}`,
      '',
      transcript,
      ''
    ].join('\n');
  }

  static stampName(title, date) {
    const d = date instanceof Date ? date : new Date();
    const p = (n) => String(n).padStart(2, '0');
    const base = ObsidianInbox.sanitizeTitle(title);
    return `${base}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  static sanitizeTitle(title) {
    const base = String(title || 'Voice note')
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
    return base || 'Voice note';
  }

  static sanitizeFolder(folder) {
    const cleaned = String(folder || '01_Inbox')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter((seg) => seg && seg !== '.' && seg !== '..')
      .join('/');
    return cleaned || '01_Inbox';
  }

  /**
   * 長文フォールバック: 全文をコピーし、貼り付け用の短いノートを開き、可能なら .md を共有する
   */
  static async fallbackLong(md, name, vault, filePath) {
    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(md);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied && window.UIManager) {
      copied = await UIManager.copyToClipboard(md);
    }

    // 共有シートはページ遷移の前に開く。obsidian:// のあとだと iOS で届かない。
    if (navigator.share) {
      try {
        const file = new File([md], `${name}.md`, { type: 'text/markdown' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: name });
        }
      } catch {
        // キャンセルしても、クリップボードと短いノートへ続ける
      }
    }

    const hint = copied
      ? '（長文のためクリップボードにコピー済み。ここに貼り付けてください）\n'
      : '（長文のため obsidian:// に載せられませんでした。共有シートの .md を保存してください）\n';
    window.location.href = ObsidianInbox.buildNewUrl(vault, filePath, hint);
  }

  static _read(key, fallback) {
    try {
      const value = (localStorage.getItem(key) || '').trim();
      return value || fallback;
    } catch {
      return fallback;
    }
  }

  static _write(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // プライベートモード等では保存できない。次回はデフォルトを使う。
    }
  }
}

window.ObsidianInbox = ObsidianInbox;
