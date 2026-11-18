import { forms, type Strings } from './en';

const de: Strings = {
  locale: 'de-DE',

  page: {
    tagline: 'Ein Tag in der Siedlung, gefilmt von unterm Katzenkinn.',
  },

  boot: {
    waking: 'Kater wird geweckt',
    unrolling: 'Siedlung wird ausgerollt',
    camera: 'Kamera wird geprüft',
    claws: 'Krallen werden gewetzt',
    ready: 'Bereit',
    noWebgl: 'Dieser Browser kann das Spiel nicht anzeigen: Es braucht WebGL 2. Ein aktuelles Chrome, Edge, Firefox oder Safari klappt.',
    noFloat: 'Die Grafik dieses Geräts kann das Spiel nicht anzeigen (keine Farbpuffer mit hohem Wertebereich). Probier einen anderen Browser oder ein anderes Gerät.',
    lost: 'Die Grafikkarte hat das Spiel fallen lassen. Lade die Seite neu, dann geht’s weiter.',
    failed: 'Start fehlgeschlagen: {why}. Prüf die Verbindung und lade die Seite neu.',
    fileMissing: 'eine Datei wurde nicht geladen ({file})',
    fileMissingPlain: 'eine Datei wurde nicht geladen',
  },

  title: {
    yourCat: 'Dein Kater',
    catName: 'Name des Katers',
    start: 'Aufnahme starten',
    goal: 'Der Kamera-Akku hält drei Minuten. Jag deinen Bruder, wirf Sachen um, kletter auf einen Baum, erobere das Revier. Alles bringt Aufrufe, und aus deinem Streifzug wird ein Video, das du posten kannst.',
    howTouch:
      '<b>Linker Daumen</b> laufen und lenken (weit schieben zum Sprinten) &nbsp;·&nbsp; <b>rechte Seite</b> wischen zum Umschauen &nbsp;·&nbsp; <b>Sprung</b> tippen zum Anspringen, halten für höhere Sprünge; ist ein Auto oder eine Mauer vor dir, landet der Kater darauf &nbsp;·&nbsp; <b>Pfoten</b> Sachen hauen &nbsp;·&nbsp; gegen einen Baum oder Zaun drücken, um hochzuklettern',
    howKeys:
      '<b>W</b> laufen &nbsp;·&nbsp; <b>Shift</b> sprinten &nbsp;·&nbsp; <b>Maus</b> oder <b>A / D</b> lenken &nbsp;·&nbsp; <b>Leertaste</b> kurz drücken zum Anspringen, halten für höhere Sprünge; ist ein Auto oder eine Mauer vor dir, landet der Kater darauf &nbsp;·&nbsp; <b>Klick</b> oder <b>Q / E</b> Pfoten &nbsp;·&nbsp; <b>F</b> miauen &nbsp;·&nbsp; gegen einen Baum oder Zaun drücken zum Klettern &nbsp;·&nbsp; <b>S</b> im Kampf zurückweichen &nbsp;·&nbsp; <b>Esc</b> Pause',
    best: 'Bester Clip bisher: {views}',
    about: 'wie es gemacht wurde, Credits',
  },

  coats: {
    ginger: 'Rot',
    tabby: 'Getigert',
    black: 'Schwarz',
    white: 'Weiß',
    grey: 'Grau',
    tux: 'Smoking',
  },

  settings: {
    heading: 'Einstellungen',
    picture: 'Bild',
    faster: 'Schneller',
    balanced: 'Ausgewogen',
    sharpest: 'Am schärfsten',
    sound: 'Ton',
    turning: 'Drehgeschwindigkeit',
    shake: 'Kamerawackeln',
    comments: 'Kommentare anzeigen',
    record: 'Clip als Video speichern',
    language: 'Sprache',
    automatic: 'Automatisch',
  },

  pause: {
    heading: 'Pause',
    resume: 'Weiter',
    restart: 'Neu starten',
    menu: 'Zurück zum Menü',
  },

  end: {
    posted: 'Clip gepostet',
    views: forms({ one: 'Aufruf', other: 'Aufrufe' }),
    likes: forms({ one: 'Like', other: 'Likes' }),
    turf: 'Revier {won} / {all}',
    best: 'Persönlicher Rekord',
    again: 'Noch eine Runde',
    menu: 'Menü',
    save: 'Clip speichern',
    share: 'Clip teilen',
    finishing: 'Dein Clip wird fertig…',
    note: 'Dein Streifzug ist ein Video, mit Punkten und Kommentaren. Poste ihn als Short, Reel oder TikTok.',
    shareText: '{title}: {views} auf Whiskercam. {link}',
  },

  touch: {
    left: 'Linke Pfote',
    right: 'Rechte Pfote',
    jump: 'Sprung',
  },

  duel: {
    you: 'Du',
    helpTouch: 'Pfoten: hauen  ·  Sprung: zurückweichen',
    helpKeys: 'Klick oder Q / E: hauen  ·  S oder Leertaste: zurückweichen',
    breathe: 'Erst mal durchatmen',
    wait: 'Warte auf die Pfote',
    batted: 'Abgewehrt!',
    pull: 'Weich zurück!',
    puffed: 'Aus der Puste',
    rivalPuffed: 'Gegner platt: hau drauf!',
    now: 'Jetzt! Hau zu!',
  },

  hints: {
    follow: 'Folge {name}',
    tagged: '{name} erwischt!',
    puffed: 'Aus der Puste',
    rivalPuffed: '{name} ist aus der Puste',
    backOff: 'Autsch. Erst mal Abstand',
    battery: 'Akku fast leer',
    guards: {
      'the bins': '{name} bewacht die Mülltonnen',
      'the car port': '{name} bewacht den Carport',
      'the square': '{name} bewacht den Platz',
      other: '{name} bewacht diese Ecke',
    },
    won: {
      'the bins': 'Die Mülltonnen: jetzt deine',
      'the car port': 'Der Carport: jetzt deiner',
      'the square': 'Der Platz: jetzt deiner',
      other: 'Diese Ecke: jetzt deine',
    },
  },

  names: {
    Rocket: 'Rocket',
    'Big Ginger': 'Rotbart',
    Duchess: 'Herzogin',
    'The Colonel': 'Herr Oberst',
  },

  deeds: {
    tag: '{name} erwischt',
    knock: 'Umgeschmissen',
    undercar: 'Unterm Auto',
    hedge: 'Durch die Hecke',
    zoomies: 'Seine fünf Minuten',
    jump: 'Riesensatz',
    counter: 'Schneller gewesen',
    dodge: 'Ins Leere hauen lassen',
    turf: 'Revier erobert',
    flawless: 'Kein Kratzer',
    lostDuel: 'Backpfeifen kassiert',
    pigeons: 'Tauben aufgescheucht',
    meow: 'Hallo gesagt',
    climb: 'Rauf auf den Baum',
    mirror: 'Wer ist das denn?',
  },

  knocks: {
    pot: 'Topf, Boden. Boden, Topf.',
    vase: 'Das war eine schöne Vase',
    gnome: 'Ein Zwerg ist gefallen',
    can: 'Dosen-Elfmeter',
    bottle: 'Flaschenkegeln',
    ball: 'Ball!',
    sign: 'Schild plattgemacht',
    lid: 'Deckel-Geschepper',
  },

  ranks: ['Stubentiger', 'Gartenentdecker', 'Straßenkater', 'Schreck des Viertels', 'Siedlungslegende', 'Internetstar'],

  clipTitle: {
    pattern: '{name} {deeds}',
    comma: ', ',
    and: ' und ',
    turfAll: 'erobert die ganze Siedlung',
    turfOne: 'gewinnt einen Revierkampf',
    turfTwo: 'gewinnt zwei Revierkämpfe',
    tag: 'erwischt endlich seinen Bruder',
    chase: 'jagt seinen schnelleren Bruder',
    knocksMany: 'wirft {n} Sachen um',
    knocksFew: 'schubst einen Topf von der Mauer',
    undercar: 'kriecht unter ein Auto',
    quiet: 'geht gemütlich spazieren',
  },

  lines: {
    idle: [
      'der ist so tief am boden', 'die kinncam macht mich fertig', 'wo will er denn hin', 'perfekter tag für verbrechen',
      'ich hör das kleine glöckchen', 'wer hat diesem tier eine kamera umgehängt', 'besser als fernsehen', 'warum bin ich so nervös',
      'diese schnurrhaare', 'erster', 'der zieht das voll durch', 'endlich wieder katzencontent', 'ich feier das so',
    ],
    chase: ['LOS LOS LOS', 'er holt auf', 'brüder halt.', 'der getigerte ist zu schnell', 'nur beine, dieser kater', 'SCHNAPP IHN', 'olympia-finale vibes'],
    tag: ['HAB IHN', 'du bist dran', 'gerechtigkeit', 'rocket am boden zerstört', 'er hat dich gewinnen lassen (hat er nicht)'],
    knock: ['NICHT DER TOPF', 'schwerkraft geprüft: funktioniert', 'kopf aus, pfote an', 'er hat ihn vorher angeguckt. vorsatz.', 'das zahlt jetzt jemand', 'klassiker'],
    gnome: ['DER ZWERG', 'ruhe in stücken, kleiner mann', 'der zwerg hatte familie'],
    undercar: ['jetzt ist es dunkel', 'unters auto wie ein profi', 'katzen sind flüssig, bestätigt', 'vorsicht auspuff'],
    hedge: ['durch die hecke!!', 'überall blätter', 'abkürzung freigeschaltet', 'hecke 0 : 1 katze'],
    zoomies: ['SEINE FÜNF MINUTEN', 'höchstgeschwindigkeit erreicht', 'kann den mal jemand stoppen', 'der hat die kraft von zehn katzen', 'zoomies!!'],
    jump: ['ABFLUG', 'landung: glatte zehn', 'parkour'],
    slap: ['KLATSCH', 'bap bap bap', 'genau auf die nase', 'diese pfoten sind fsk 0'],
    counter: ['er war schneller!!', 'reflexe', 'den hat er kommen sehen'],
    dodge: ['matrix-move', 'daneben', 'zu langsam'],
    playerHit: ['autsch', 'das hat gesessen', 'abschütteln', 'das war persönlich'],
    turf: ['NEUER KÖNIG', 'die mülltonnen gehören uns', 'der ist abgehauen!!', 'respekt verdient', 'das ist jetzt seine siedlung'],
    lostDuel: ['nochmal', 'schmerz', 'die katze geht pumpen', 'taktischer rückzug'],
    battery: ['akku stirbt neiiin', 'nicht jetzt aufhören', 'kann mal jemand die katze laden'],
    duelStart: ['oh nein', 'jetzt geht’s los', 'der guckt fies', 'fäuste hoch', 'ohren angelegt. jetzt wird’s ernst.'],
    pigeons: ['TAUBEN', 'darauf hat er den ganzen tag gewartet', 'chaos'],
    climb: ['WIE kommt er da wieder runter', 'ruft mal jemand die feuerwehr', 'was für eine aussicht', 'baumkatze', 'der wohnt jetzt da oben'],
    blocked: ['abgewehrt', 'hör auf rumzufuchteln!!', 'warte doch mal', 'geduld, kleiner tiger'],
    rivalWinded: ['der ist platt, LOS', 'jetzt jetzt jetzt', 'keine puste mehr lol'],
    meow: ['er hat hallo gesagt', 'MIAU', 'heute gesprächig', 'kann das mal jemand übersetzen', 'er ruft seinen bruder'],
    mirror: [
      'ER SIEHT SICH SELBST', 'wer ist dieser hübsche kater', 'die andere katze hat auch ne kamera', 'er checkt nicht, dass er das ist',
      'hauptcharakter-moment', 'anstarr-duell mit sich selbst', 'der in der tür hat angefangen',
    ],
  },
};

export default de;
