/**
 * VoiceScribe — スマート要約・要点整理モジュール (TextSummarizer)
 * 自然言語処理（TFスコア・文構造解析・重要語抽出）により、
 * 端末内（オフライン）で瞬時に要点箇条書き・見出し・アクションを生成
 */

class TextSummarizer {
  /**
   * テキストを要約・構造化整理
   * @param {string} text - 文字起こしテキスト
   * @param {'ja-JP'|'en-US'} language - 言語
   * @returns {{headline: string, summaryBullets: Array<string>, keywords: Array<string>, actionItems: Array<string>, formattedText: string}}
   */
  static summarize(text, language = 'ja-JP') {
    if (!text || !text.trim()) {
      return {
        headline: '（テキストなし）',
        summaryBullets: [],
        keywords: [],
        actionItems: [],
        formattedText: ''
      };
    }

    const cleanText = text.trim();

    if (language === 'ja-JP') {
      return this._summarizeJapanese(cleanText);
    } else {
      return this._summarizeEnglish(cleanText);
    }
  }

  /**
   * 日本語テキストのスマート要約
   * @param {string} text
   * @private
   */
  static _summarizeJapanese(text) {
    // 1. 文に分割
    const sentences = text
      .split(/[。\n\r！？\!\?]+/)
      .map(s => s.trim())
      .filter(s => s.length >= 4);

    if (sentences.length === 0) {
      return {
        headline: text.substring(0, 25),
        summaryBullets: [text],
        keywords: [],
        actionItems: [],
        formattedText: text
      };
    }

    // 2. キーワード抽出（名詞・重要語の出現頻度分析）
    const wordCounts = {};
    const stopWords = new Set([
      'こと', 'もの', 'ため', 'よう', 'そう', 'これ', 'それ', 'あれ', 'どれ',
      'ここ', 'そこ', 'あそこ', 'どこ', '私', '僕', '自分', '今日', '昨日', '明日',
      'です', 'ます', 'した', 'から', 'ので', 'けど', 'また', 'そして', 'しかし',
      'ちょっと', 'なんか', 'やっぱり', '思う', 'いう', 'ある', 'なる', 'する'
    ]);

    // 簡易形態素・重要語パターン抽出
    const wordPattern = /([一-龠]{2,8}|[ァ-ヶー]{2,10}|[a-zA-Z0-9]{3,15})/g;
    let match;
    while ((match = wordPattern.exec(text)) !== null) {
      const word = match[1];
      if (!stopWords.has(word) && word.length >= 2) {
        wordCounts[word] = (wordCounts[word] || 0) + 1;
      }
    }

    // スコア順にソートして上位キーワードを抽出
    const sortedWords = Object.keys(wordCounts).sort((a, b) => wordCounts[b] - wordCounts[a]);
    const topKeywords = sortedWords.slice(0, 5);

    // 3. 各文の重要度スコアリング
    const sentenceScores = sentences.map((sentence, idx) => {
      let score = 0;

      // キーワード含有スコア
      topKeywords.forEach(kw => {
        if (sentence.includes(kw)) score += (wordCounts[kw] || 1) * 2;
      });

      // 重要マーカー表現のスコア加算
      if (/(決定|確認|予定|重要|課題|問題|目標|結論|要するに|結果|方針|依頼|タスク|締切|期日)/.test(sentence)) {
        score += 8;
      }
      if (/(〜する|〜します|〜てください|〜必要があります|〜することになった|〜方針です)/.test(sentence)) {
        score += 4;
      }

      // 位置ボーナス（冒頭と結びは重要）
      if (idx === 0) score += 3;
      if (idx === sentences.length - 1) score += 2;

      // 長さペナルティ（短すぎる・長すぎる文を抑制）
      if (sentence.length >= 10 && sentence.length <= 60) score += 2;

      return { sentence, score, index: idx };
    });

    // 4. アクションアイテム（やるべきこと・決定事項）の抽出
    const actionItems = [];
    sentences.forEach(s => {
      if (/(すること|してください|する予定|決定|タスク|締切|期日|確認する|作成する|送る|提出|実施|対応)/.test(s)) {
        const cleanAction = s.replace(/^[・\-\s]+/, '').trim();
        if (cleanAction && !actionItems.includes(cleanAction) && actionItems.length < 3) {
          actionItems.push(cleanAction);
        }
      }
    });

    // 5. 重要文を上位から最大3つ選択（元の登場順を維持）
    const selectedSentences = sentenceScores
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(3, sentences.length))
      .sort((a, b) => a.index - b.index)
      .map(item => item.sentence);

    // 6. 簡略化された見出し（Headline）の生成
    let headline = '';
    if (topKeywords.length >= 2) {
      headline = `📌 ${topKeywords.slice(0, 3).join('・')}について`;
    } else if (sentences[0]) {
      headline = `📌 ${sentences[0].substring(0, 24)}${sentences[0].length > 24 ? '...' : ''}`;
    } else {
      headline = '📌 録音メモ';
    }

    // 7. 構造化テキストの生成
    const bulletList = selectedSentences.map(s => `・${s}`);
    let formatted = `【要点まとめ】\n${bulletList.join('\n')}`;

    if (topKeywords.length > 0) {
      formatted += `\n\n【キーワード】\n${topKeywords.map(k => `#${k}`).join(' ')}`;
    }

    if (actionItems.length > 0) {
      formatted += `\n\n【決定・アクション】\n${actionItems.map((a, i) => `${i + 1}. ${a}`).join('\n')}`;
    }

    return {
      headline: headline,
      summaryBullets: selectedSentences,
      keywords: topKeywords,
      actionItems: actionItems,
      formattedText: formatted
    };
  }

  /**
   * 英語テキストのスマート要約
   * @param {string} text
   * @private
   */
  static _summarizeEnglish(text) {
    const sentences = text
      .split(/[.\n\r!?]+/)
      .map(s => s.trim())
      .filter(s => s.length >= 8);

    if (sentences.length === 0) {
      return {
        headline: text.substring(0, 30),
        summaryBullets: [text],
        keywords: [],
        actionItems: [],
        formattedText: text
      };
    }

    // キーワード抽出
    const words = text.toLowerCase().match(/\b[a-z]{4,15}\b/g) || [];
    const stopWords = new Set(['this', 'that', 'with', 'from', 'have', 'were', 'they', 'will', 'about', 'there', 'what', 'when', 'where', 'which', 'would', 'could', 'should']);
    const wordCounts = {};

    words.forEach(w => {
      if (!stopWords.has(w)) wordCounts[w] = (wordCounts[w] || 0) + 1;
    });

    const topKeywords = Object.keys(wordCounts).sort((a, b) => wordCounts[b] - wordCounts[a]).slice(0, 5);

    // 文抽出
    const selectedSentences = sentences.slice(0, Math.min(3, sentences.length));
    const headline = topKeywords.length > 0 ? `📌 Topic: ${topKeywords.slice(0, 3).join(', ')}` : `📌 ${sentences[0].substring(0, 30)}...`;

    let formatted = `[Summary]\n${selectedSentences.map(s => `• ${s}`).join('\n')}`;
    if (topKeywords.length > 0) {
      formatted += `\n\n[Keywords]\n${topKeywords.map(k => `#${k}`).join(' ')}`;
    }

    return {
      headline: headline,
      summaryBullets: selectedSentences,
      keywords: topKeywords,
      actionItems: [],
      formattedText: formatted
    };
  }
}

// グローバルエクスポート
window.TextSummarizer = TextSummarizer;
