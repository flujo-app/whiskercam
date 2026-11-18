import { forms, type Strings } from './en';

const pl: Strings = {
  locale: 'pl-PL',

  page: {
    tagline: 'Dzień na osiedlu, nagrany spod kociej brody.',
  },

  boot: {
    waking: 'Budzimy kota',
    unrolling: 'Rozkładamy osiedle',
    camera: 'Sprawdzamy kamerkę',
    claws: 'Ostrzymy pazury',
    ready: 'Gotowe',
    noWebgl: 'Ta przeglądarka nie pokaże gry: potrzebny jest WebGL 2. Zadziała aktualny Chrome, Edge, Firefox albo Safari.',
    noFloat: 'Grafika tego urządzenia nie pokaże gry (brak buforów kolorów o wysokim zakresie). Spróbuj innej przeglądarki albo innego urządzenia.',
    lost: 'Karta graficzna zgubiła grę. Odśwież stronę, żeby grać dalej.',
    failed: 'Nie udało się uruchomić: {why}. Sprawdź połączenie i odśwież stronę.',
    fileMissing: 'nie wczytał się plik ({file})',
    fileMissingPlain: 'nie wczytał się jeden z plików',
  },

  title: {
    yourCat: 'Twój kot',
    catName: 'Imię kota',
    start: 'Zacznij nagrywać',
    goal: 'Bateria w kamerce starcza na trzy minuty. Goń brata, zrzucaj, co się da, wejdź na drzewo, wywalcz rewir. Za wszystko lecą wyświetlenia, a cała runda staje się filmikiem, który możesz wrzucić do sieci.',
    howTouch:
      '<b>Lewy kciuk</b> biegnij i skręcaj (pchnij mocno, żeby pędzić) &nbsp;·&nbsp; <b>prawa strona</b> przeciągnij, żeby się rozglądać &nbsp;·&nbsp; <b>Skok</b> stuknij, żeby się rzucić, przytrzymaj, żeby skoczyć wyżej; jeśli przed kotem stoi auto albo murek, kot na nim wyląduje &nbsp;·&nbsp; <b>łapy</b> trzepią, co popadnie &nbsp;·&nbsp; napieraj na drzewo albo płot, żeby się wspiąć',
    howKeys:
      '<b>W</b> biegnij &nbsp;·&nbsp; <b>Shift</b> pędź &nbsp;·&nbsp; <b>mysz</b> albo <b>A / D</b> skręcaj &nbsp;·&nbsp; <b>Spacja</b> stuknij, żeby się rzucić, przytrzymaj, żeby skoczyć wyżej; jeśli przed kotem stoi auto albo murek, kot na nim wyląduje &nbsp;·&nbsp; <b>klik</b> albo <b>Q / E</b> łapy &nbsp;·&nbsp; <b>F</b> miaucz &nbsp;·&nbsp; napieraj na drzewo albo płot, żeby się wspiąć &nbsp;·&nbsp; <b>S</b> odskocz w walce &nbsp;·&nbsp; <b>Esc</b> pauza',
    best: 'Najlepszy klip: {views}',
    about: 'jak to powstało, autorzy',
  },

  coats: {
    ginger: 'Rudy',
    tabby: 'Pręgowany',
    black: 'Czarny',
    white: 'Biały',
    grey: 'Szary',
    tux: 'We fraku',
  },

  settings: {
    heading: 'Ustawienia',
    picture: 'Obraz',
    faster: 'Szybszy',
    balanced: 'Zrównoważony',
    sharpest: 'Najostrzejszy',
    sound: 'Dźwięk',
    turning: 'Szybkość obrotu',
    shake: 'Drgania kamery',
    comments: 'Pokazuj komentarze widzów',
    record: 'Zapisuj klip jako wideo',
    language: 'Język',
    automatic: 'Automatycznie',
  },

  pause: {
    heading: 'Pauza',
    resume: 'Graj dalej',
    restart: 'Od nowa',
    menu: 'Wróć do menu',
  },

  end: {
    posted: 'Klip wrzucony!',
    views: forms({ one: 'wyświetlenie', few: 'wyświetlenia', many: 'wyświetleń', other: 'wyświetlenia' }),
    likes: forms({ one: 'lajk', few: 'lajki', many: 'lajków', other: 'lajka' }),
    turf: 'Rewiry {won} / {all}',
    best: 'Rekord życiowy',
    again: 'Jeszcze raz',
    menu: 'Menu',
    save: 'Zapisz klip',
    share: 'Udostępnij klip',
    finishing: 'Montujemy twój klip…',
    note: 'Twoja runda to gotowy filmik, razem z wynikiem i komentarzami. Wrzuć go jako Shorta, Reelsa albo TikToka.',
    shareText: '{title}: {views} na Whiskercam. {link}',
  },

  touch: {
    left: 'Lewa łapa',
    right: 'Prawa łapa',
    jump: 'Skok',
  },

  duel: {
    you: 'Ty',
    helpTouch: 'łapy: trzepnij  ·  Skok: odskocz',
    helpKeys: 'klik albo Q / E: trzepnij  ·  S albo Spacja: odskocz',
    breathe: 'Złap oddech',
    wait: 'Czekaj na łapę',
    batted: 'Odbite!',
    pull: 'Odskocz!',
    puffed: 'Zadyszka',
    rivalPuffed: 'Ma zadyszkę: trzepnij!',
    now: 'Teraz! Trzepnij!',
  },

  hints: {
    follow: '{name}: biegnij za nim',
    tagged: 'Złapany: {name}!',
    puffed: 'Zadyszka',
    rivalPuffed: '{name} ma zadyszkę',
    backOff: 'Au. Na razie odpuść',
    battery: 'Słaba bateria',
    guards: {
      'the bins': '{name} pilnuje śmietników',
      'the car port': '{name} pilnuje wiaty',
      'the square': '{name} pilnuje placu',
      other: '{name} pilnuje tego miejsca',
    },
    won: {
      'the bins': 'Śmietniki są teraz twoje',
      'the car port': 'Wiata jest teraz twoja',
      'the square': 'Plac jest teraz twój',
      other: 'To miejsce jest teraz twoje',
    },
  },

  names: {
    Rocket: 'Rocket',
    'Big Ginger': 'Wielki Rudy',
    Duchess: 'Księżna',
    'The Colonel': 'Pułkownik',
  },

  deeds: {
    tag: 'Złapany: {name}',
    knock: 'Zrzucone!',
    undercar: 'Pod autem',
    hedge: 'Przez żywopłot',
    zoomies: 'Głupawka',
    jump: 'Wielki skok',
    counter: 'Szybszy o łapę',
    dodge: 'Pudło!',
    turf: 'Rewir zdobyty',
    flawless: 'Bez zadrapania',
    lostDuel: 'Dostał po pysku',
    pigeons: 'Gołębie w rozsypce',
    meow: 'Przywitał się',
    climb: 'Na drzewie',
    mirror: 'A to kto?',
  },

  knocks: {
    pot: 'Doniczko, poznaj glebę',
    vase: 'To był ładny wazon',
    gnome: 'Krasnal padł',
    can: 'Puszka kopnęła w kalendarz',
    bottle: 'Kręgle z butelek',
    ball: 'Piłka!',
    sign: 'Znak na płasko',
    lid: 'Klapa od kubła: łup!',
  },

  ranks: ['Kot kanapowy', 'Odkrywca ogródków', 'Dachowiec', 'Postrach okolicy', 'Legenda osiedla', 'Gwiazda internetu'],

  clipTitle: {
    pattern: '{name} {deeds}',
    comma: ', ',
    and: ' i ',
    turfAll: 'przejmuje całe osiedle',
    turfOne: 'wygrywa wojnę o rewir',
    turfTwo: 'wygrywa dwie wojny o rewir',
    tag: 'w końcu łapie brata',
    chase: 'goni szybszego brata',
    knocksMany: 'zrzuca {n} rzeczy',
    knocksFew: 'strąca doniczkę z murku',
    undercar: 'włazi pod samochód',
    quiet: 'idzie na spokojny spacerek',
  },

  lines: {
    idle: [
      'jaki on nisko przy ziemi', 'ta kamerka pod brodą mnie rozwala', 'gdzie on idzie', 'piękny dzień na przestępstwa',
      'słyszę ten mały dzwoneczek', 'kto dał kamerę temu zwierzęciu', 'lepsze niż telewizja', 'czemu ja się stresuję',
      'te wąsiki', 'pierwszy', 'zaangażowanie w rolę 10/10', 'jest kot, są zasięgi', 'oglądam to zamiast pracować',
    ],
    chase: ['DAWAJ DAWAJ DAWAJ', 'dogania go', 'bracia.', 'ten pręgowany jest za szybki', 'ale on zasuwa', 'ŁAP GO', 'finał olimpijski normalnie'],
    tag: ['MA GO', 'berek, ty gonisz', 'sprawiedliwość', 'rocket właśnie płacze w poduszkę', 'dał ci wygrać (nie dał)'],
    knock: ['TYLKO NIE DONICZKA', 'grawitacja sprawdzona', 'w głowie pusto, łapa pcha', 'najpierw się popatrzył. z premedytacją.', 'ktoś za to zapłaci', 'klasyk'],
    gnome: ['KRASNAL', 'spoczywaj w kawałkach, mały', 'krasnal miał rodzinę'],
    undercar: ['zrobiło się ciemno', 'pod autem jak zawodowiec', 'koty to ciecz, potwierdzone', 'uważaj na rurę wydechową'],
    hedge: ['przez żywopłot!!', 'wszędzie liście', 'skrót odblokowany', 'żywopłot: 0 kot: 1'],
    zoomies: ['GŁUPAWKA', 'osiągnięto prędkość maksymalną', 'niech ktoś go zatrzyma', 'szybki jak dziesięć kotów'],
    jump: ['LOT', 'lądowanie z telemarkiem', 'parkour', 'małysz by się nie powstydził'],
    slap: ['PAC', 'pac pac pac', 'prosto w nos', 'te łapy powinny mieć pozwolenie na broń'],
    counter: ['był pierwszy!!', 'refleks', 'przejrzał go na wylot'],
    dodge: ['unik jak w matrixie', 'pudło', 'za wolno'],
    playerHit: ['auć', 'to musiało boleć', 'otrząśnij się', 'to było osobiste'],
    turf: ['NOWY KRÓL', 'śmietniki są nasze', 'ZWIAŁ!!', 'szacunek zdobyty', 'to teraz jego osiedle'],
    lostDuel: ['jeszcze raz', 'ból', 'ten kot chodzi na siłkę', 'strategiczny odwrót'],
    battery: ['bateria pada nieee', 'nie kończ teraz', 'niech ktoś naładuje tego kota'],
    duelStart: ['o nie', 'no to się zaczyna', 'ten wygląda groźnie', 'solówka', 'uszy po sobie. będzie się działo.'],
    pigeons: ['GOŁĘBIE', 'czekał na to cały dzień', 'chaos'],
    climb: ['JAK on stamtąd zejdzie', 'dzwońcie po straż pożarną', 'ale musi być stamtąd widok', 'kot nadrzewny', 'on tam teraz mieszka'],
    blocked: ['odbite', 'przestań machać!!', 'czekaj, czekaj', 'cierpliwości, mały tygrysie'],
    rivalWinded: ['ma zadyszkę, DAWAJ', 'teraz teraz teraz', 'brak tchu xd'],
    meow: ['powiedział cześć', 'MIAU', 'gadatliwy dzisiaj', 'niech ktoś to przetłumaczy', 'woła brata'],
    mirror: [
      'WIDZI SIEBIE', 'kim jest ten przystojniak', 'tamten kot też ma kamerę', 'nie wie, że to on',
      'moment głównego bohatera', 'pojedynek na spojrzenia z samym sobą', 'to kot w drzwiach zaczął',
    ],
  },
};

export default pl;
