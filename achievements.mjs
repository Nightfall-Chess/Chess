const levels = [
  { tier: "Bronze", title: "First Light", faTitle: "نخستین نور" },
  { tier: "Silver", title: "Night Study", faTitle: "مطالعهٔ شبانه" },
  { tier: "Gold", title: "Deep Calculation", faTitle: "محاسبهٔ ژرف" },
  { tier: "Diamond", title: "Nightfall Master", faTitle: "استاد شب‌فام" }
];

const definitions = [
  { id: "games", category: "Consistency", faCategory: "پیوستگی", thresholds: [1, 10, 25, 100], icon: "♟", title: "Games in the Archive", faTitle: "بازی‌های بایگانی‌شده", description: "Complete games and keep their full records.", faDescription: "بازی‌ها را کامل کنید و سابقهٔ کاملشان را نگه دارید." },
  { id: "wins", category: "Gameplay", faCategory: "بازی", thresholds: [1, 5, 10, 25], icon: "♔", title: "Victories", faTitle: "پیروزی‌ها", description: "Earn wins in completed games.", faDescription: "در بازی‌های کامل‌شده پیروز شوید." },
  { id: "checkmates", category: "Gameplay", faCategory: "بازی", thresholds: [1, 3, 5, 10], icon: "♚", title: "Checkmates", faTitle: "کیش‌ومات‌ها", description: "Finish games with checkmate.", faDescription: "بازی‌ها را با کیش‌ومات به پایان برسانید." },
  { id: "streak", category: "Gameplay", faCategory: "بازی", thresholds: [3, 5, 10, 20], icon: "✦", title: "Winning Streak", faTitle: "رشتهٔ پیروزی", description: "Build your longest recorded run of wins.", faDescription: "طولانی‌ترین رشتهٔ پیروزی ثبت‌شدهٔ خود را بسازید." },
  { id: "puzzles", category: "Learning", faCategory: "یادگیری", thresholds: [1, 10, 25, 100], icon: "♞", title: "Tactical Studies", faTitle: "تمرین‌های تاکتیکی", description: "Solve rated chess puzzles.", faDescription: "معماهای شطرنجِ دارای درجه را حل کنید." },
  { id: "lessons", category: "Learning", faCategory: "یادگیری", thresholds: [1, 5, 10, 49], icon: "♧", title: "Academy Lessons", faTitle: "درس‌های آکادمی", description: "Complete lessons in the Nightfall Academy.", faDescription: "درس‌های آکادمی شب‌فام را کامل کنید." },
  { id: "castling", category: "Gameplay", faCategory: "بازی", thresholds: [1, 5, 10, 25], icon: "♜", title: "King to Shelter", faTitle: "شاه به پناهگاه", description: "Castle in completed games.", faDescription: "در بازی‌های کامل‌شده قلعه بروید." },
  { id: "promotion", category: "Gameplay", faCategory: "بازی", thresholds: [1, 3, 5, 10], icon: "♕", title: "New Crown", faTitle: "تاج تازه", description: "Promote pawns in completed games.", faDescription: "در بازی‌های کامل‌شده پیاده را ارتقا دهید." },
  { id: "brilliant", category: "Advanced", faCategory: "پیشرفته", thresholds: [1, 3, 5, 10], icon: "✧", title: "Quiet Brilliance", faTitle: "درخشش آرام", description: "Earn brilliant classifications from Stockfish analysis.", faDescription: "با تحلیل Stockfish حرکت درخشان به دست آورید." },
  { id: "reviews", category: "Learning", faCategory: "یادگیری", thresholds: [1, 5, 10, 25], icon: "⌕", title: "After the Game", faTitle: "پس از بازی", description: "Review games with saved engine analysis.", faDescription: "بازی‌ها را با تحلیل ذخیره‌شدهٔ موتور مرور کنید." },
  { id: "daily", category: "Consistency", faCategory: "پیوستگی", thresholds: [3, 7, 14, 30], icon: "☾", title: "Daily Return", faTitle: "بازگشت روزانه", description: "Build your best daily activity streak.", faDescription: "بهترین رشتهٔ فعالیت روزانهٔ خود را بسازید." }
];

function gameMoveCount(games, predicate) {
  return games.reduce((sum, game) => sum + (game.entries || []).filter(entry => predicate(entry.move, entry.analysis)).length, 0);
}

export function getAchievementProgress({ games = [], profile = {}, completedLessons = 0 } = {}) {
  const reviewedGames = games.filter(game => game.entries?.length && game.entries.every(entry => entry.analysis)).length;
  const values = {
    games: games.length,
    wins: games.filter(game => game.outcome === "win").length,
    checkmates: games.filter(game => /checkmate/i.test(game.resultText || "")).length,
    streak: profile.bestWinStreak || 0,
    puzzles: profile.puzzlesSolved || 0,
    lessons: completedLessons,
    castling: gameMoveCount(games, move => Boolean(move?.castle)),
    promotion: gameMoveCount(games, move => Boolean(move?.promoteTo)),
    brilliant: gameMoveCount(games, (_, analysis) => analysis?.label === "Brilliant"),
    reviews: reviewedGames,
    daily: profile.bestDailyStreak || 0
  };
  return definitions.map(definition => {
    const value = Number.isFinite(values[definition.id]) ? values[definition.id] : 0;
    const level = definition.thresholds.filter(threshold => value >= threshold).length;
    const next = definition.thresholds[level];
    return {
      ...definition,
      value,
      level,
      next,
      progress: next ? Math.max(0, Math.min(1, value / next)) : 1,
      levels: levels.map((tier, index) => ({ ...tier, threshold: definition.thresholds[index] }))
    };
  });
}
