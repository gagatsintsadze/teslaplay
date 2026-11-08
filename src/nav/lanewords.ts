/**
 * Lane-change wording for the banner chip and the voice, in the map language (English, Georgian,
 * Russian; anything else falls back to English). The rest of the spoken guidance stays in the
 * router's language, so only the lane prompts are translated here.
 */
export type LaneLang = 'en' | 'ka' | 'ru';

export const laneLang = (mapLang: string): LaneLang => {
  const l = mapLang.slice(0, 2).toLowerCase();
  return l === 'ka' || l === 'ru' ? l : 'en';
};

interface Words {
  move(lanes: number, dir: 'left' | 'right'): string;
  forTurn(move: string): string;
  cannotTurn(move: string): string;
  wrongLane: string;
}

const EN: Words = {
  move: (n, d) => (n === 1 ? `Move one lane ${d}` : `Move ${n} lanes ${d}`),
  forTurn: (m) => `${m} for the turn.`,
  cannotTurn: (m) => `You cannot turn from this lane. ${m} now.`,
  wrongLane: 'Wrong lane',
};

const KA: Words = {
  move: (n, d) => {
    const side = d === 'left' ? 'მარცხნივ' : 'მარჯვნივ';
    return n === 1 ? `გადადით ერთი ზოლით ${side}` : `გადადით ${n} ზოლით ${side}`;
  },
  forTurn: (m) => `${m} მოსახვევისთვის.`,
  cannotTurn: (m) => `ამ ზოლიდან მოხვევა არ შეიძლება. ${m} ახლავე.`,
  wrongLane: 'არასწორი ზოლი',
};

const RU: Words = {
  move: (n, d) => {
    const side = d === 'left' ? 'левее' : 'правее';
    if (n === 1) return `Перестройтесь на одну полосу ${side}`;
    const word = n >= 2 && n <= 4 ? 'полосы' : 'полос';
    return `Перестройтесь на ${n} ${word} ${side}`;
  },
  forTurn: (m) => `${m} для поворота.`,
  cannotTurn: (m) => `Из этой полосы поворот невозможен. ${m} сейчас.`,
  wrongLane: 'Не та полоса',
};

export const LANE_WORDS: Record<LaneLang, Words> = { en: EN, ka: KA, ru: RU };
export const laneWords = (mapLang: string): Words => LANE_WORDS[laneLang(mapLang)];
