/* 5-Card Pineapple — cards and hand evaluation.
   Used by the server (require) and the page (<script src="engine.js">). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else Object.assign(root, factory());
})(typeof self !== 'undefined' ? self : this, function () {
  const SUITS = ['♠', '♥', '♦', '♣'];
  const SUIT_NAME = ['spades', 'hearts', 'diamonds', 'clubs'];
  const RANK_STR = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const RANK_NAME = { 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
  const RANK_PLURAL = { 2: 'Twos', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes', 7: 'Sevens', 8: 'Eights', 9: 'Nines', 10: 'Tens', 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces' };

  function rankStr(r) { return RANK_STR[r] || String(r); }
  function cardId(c) { return c.r + '-' + c.s; }
  function cardText(c) { return rankStr(c.r) + SUITS[c.s]; }
  function makeDeck() { const d = []; for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) d.push({ r, s }); return d; }
  function shuffle(a, rnd) {
    rnd = rnd || function (n) { return Math.floor(Math.random() * n); };
    for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function sortHand(h) { return h.sort((a, b) => b.r - a.r || a.s - b.s); }

  function eval5(cards) {
    const ranks = cards.map(c => c.r).sort((a, b) => b - a);
    const flush = cards.every(c => c.s === cards[0].s);
    const counts = {};
    for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
    const groups = Object.keys(counts).map(r => ({ r: +r, n: counts[r] })).sort((a, b) => b.n - a.n || b.r - a.r);
    let straightHigh = 0;
    if (groups.length === 5) {
      if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
      else if (ranks[0] === 14 && ranks[1] === 5 && ranks[4] === 2) straightHigh = 5; // the wheel
    }
    let cat, tb;
    if (straightHigh && flush) { cat = 8; tb = [straightHigh]; }
    else if (groups[0].n === 4) { cat = 7; tb = [groups[0].r, groups[1].r]; }
    else if (groups[0].n === 3 && groups[1].n === 2) { cat = 6; tb = [groups[0].r, groups[1].r]; }
    else if (flush) { cat = 5; tb = ranks; }
    else if (straightHigh) { cat = 4; tb = [straightHigh]; }
    else if (groups[0].n === 3) { cat = 3; tb = groups.map(g => g.r); }
    else if (groups[0].n === 2 && groups[1].n === 2) { cat = 2; tb = groups.map(g => g.r); }
    else if (groups[0].n === 2) { cat = 1; tb = groups.map(g => g.r); }
    else { cat = 0; tb = ranks; }
    return { cat, tb, score: [cat].concat(tb) };
  }
  function cmpScore(a, b) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; }
    return 0;
  }
  /* best five of up to seven cards; returns {cat, tb, score, used:[cards]} */
  function bestHand(cards) {
    let best = null;
    const n = cards.length;
    const pick = [];
    (function rec(start) {
      if (pick.length === 5) {
        const h = eval5(pick);
        if (!best || cmpScore(h.score, best.score) > 0) best = Object.assign({ used: pick.slice() }, h);
        return;
      }
      for (let i = start; i < n; i++) { pick.push(cards[i]); rec(i + 1); pick.pop(); }
    })(0);
    return best;
  }
  function handName(h) {
    const t = h.tb;
    switch (h.cat) {
      case 8: return t[0] === 14 ? 'Royal flush' : 'Straight flush, ' + RANK_NAME[t[0]].toLowerCase() + ' high';
      case 7: return 'Four of a kind, ' + RANK_PLURAL[t[0]].toLowerCase();
      case 6: return 'Full house, ' + RANK_PLURAL[t[0]].toLowerCase() + ' full of ' + RANK_PLURAL[t[1]].toLowerCase();
      case 5: return 'Flush, ' + RANK_NAME[t[0]].toLowerCase() + ' high';
      case 4: return 'Straight, ' + RANK_NAME[t[0]].toLowerCase() + ' high';
      case 3: return 'Three of a kind, ' + RANK_PLURAL[t[0]].toLowerCase();
      case 2: return 'Two pair, ' + RANK_PLURAL[t[0]].toLowerCase() + ' and ' + RANK_PLURAL[t[1]].toLowerCase();
      case 1: return 'Pair of ' + RANK_PLURAL[t[0]].toLowerCase();
      default: return RANK_NAME[t[0]] + ' high';
    }
  }

  return { SUITS, SUIT_NAME, RANK_NAME, RANK_PLURAL, rankStr, cardId, cardText, makeDeck, shuffle, sortHand, eval5, cmpScore, bestHand, handName };
});
