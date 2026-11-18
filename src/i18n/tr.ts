import { forms, type Strings } from './en';

const tr: Strings = {
  locale: 'tr-TR',

  page: {
    tagline: 'Sitede bir gün, bir kedinin çenesinin altından çekildi.',
  },

  boot: {
    waking: 'Kedi uyandırılıyor',
    unrolling: 'Site seriliyor',
    camera: 'Kamera kontrol ediliyor',
    claws: 'Tırnaklar bileniyor',
    ready: 'Hazır',
    noWebgl: 'Bu tarayıcı oyunu gösteremiyor: WebGL 2 gerekiyor. Güncel bir Chrome, Edge, Firefox ya da Safari iş görür.',
    noFloat: 'Bu cihazın grafik birimi oyunu gösteremiyor (yüksek aralıklı renk arabelleği yok). Başka bir tarayıcı ya da cihaz dene.',
    lost: 'Ekran kartı oyunu düşürdü. Devam etmek için sayfayı yenile.',
    failed: 'Başlatılamadı: {why}. Bağlantını kontrol edip sayfayı yenile.',
    fileMissing: 'bir dosya yüklenemedi ({file})',
    fileMissingPlain: 'bir dosya yüklenemedi',
  },

  title: {
    yourCat: 'Kedin',
    catName: 'Kedinin adı',
    start: 'Kaydı başlat',
    goal: 'Kameranın pili üç dakika dayanıyor. Kardeşini kovala, ortalığı devir, ağaca tırman, bölgeyi ele geçir. Her şey izlenme getirir ve bu tur, paylaşabileceğin bir videoya dönüşür.',
    howTouch:
      '<b>Sol başparmak</b> koş ve yön ver (depar için iyice it) &nbsp;·&nbsp; <b>sağ taraf</b> bakmak için sürükle &nbsp;·&nbsp; <b>Zıpla</b> dokun: atıl, basılı tut: daha yükseğe sıçra; önünde araba ya da duvar varsa kedi üstüne konar &nbsp;·&nbsp; <b>patiler</b> ortalığa şaplak at &nbsp;·&nbsp; tırmanmak için bir ağaca ya da çite doğru it',
    howKeys:
      '<b>W</b> koş &nbsp;·&nbsp; <b>Shift</b> depar &nbsp;·&nbsp; <b>fare</b> ya da <b>A / D</b> yön ver &nbsp;·&nbsp; <b>Boşluk</b> kısa bas: atıl, basılı tut: daha yükseğe sıçra; önünde araba ya da duvar varsa kedi üstüne konar &nbsp;·&nbsp; <b>tık</b> ya da <b>Q / E</b> patiler &nbsp;·&nbsp; <b>F</b> miyavla &nbsp;·&nbsp; tırmanmak için bir ağaca ya da çite doğru it &nbsp;·&nbsp; <b>S</b> kavgada geri çekil &nbsp;·&nbsp; <b>Esc</b> duraklat',
    best: 'En iyi klibin: {views}',
    about: 'nasıl yapıldı, emeği geçenler',
  },

  coats: {
    ginger: 'Sarman',
    tabby: 'Tekir',
    black: 'Siyah',
    white: 'Beyaz',
    grey: 'Gri',
    tux: 'Smokin',
  },

  settings: {
    heading: 'Ayarlar',
    picture: 'Görüntü',
    faster: 'Daha hızlı',
    balanced: 'Dengeli',
    sharpest: 'En net',
    sound: 'Ses',
    turning: 'Dönüş hızı',
    shake: 'Kamera sarsıntısı',
    comments: 'Yorumları göster',
    record: 'Klibi video olarak sakla',
    language: 'Dil',
    automatic: 'Otomatik',
  },

  pause: {
    heading: 'Duraklatıldı',
    resume: 'Devam et',
    restart: 'Baştan başla',
    menu: 'Menüye dön',
  },

  end: {
    posted: 'Klip paylaşıldı',
    views: forms({ other: 'izlenme' }),
    likes: forms({ other: 'beğeni' }),
    turf: 'Bölge {won} / {all}',
    best: 'Kişisel rekor',
    again: 'Bir tur daha',
    menu: 'Menü',
    save: 'Klibi kaydet',
    share: 'Klibi paylaş',
    finishing: 'Klibin hazırlanıyor…',
    note: 'Turun bir video oldu; skor ve yorumlar da içinde. Short, Reel ya da TikTok olarak paylaş.',
    shareText: '{title}: Whiskercam’de {views}. {link}',
  },

  touch: {
    left: 'Sol pati',
    right: 'Sağ pati',
    jump: 'Zıpla',
  },

  duel: {
    you: 'Sen',
    helpTouch: 'pati tuşları: şaplak  ·  Zıpla tuşu: geri çekil',
    helpKeys: 'tık ya da Q / E: şaplak  ·  S ya da Boşluk: geri çekil',
    breathe: 'Soluklan',
    wait: 'Patiyi bekle',
    batted: 'Savuşturuldu!',
    pull: 'Geri çekil!',
    puffed: 'Nefesin kesildi',
    rivalPuffed: 'Nefesi kesildi: şaplak at!',
    now: 'Şimdi! Şaplak!',
  },

  hints: {
    follow: '{name} önde, peşinden git',
    tagged: '{name} yakalandı!',
    puffed: 'Nefesin kesildi',
    rivalPuffed: '{name} nefes nefese',
    backOff: 'Ay. Şimdilik geri çekil',
    battery: 'Pil azaldı',
    guards: {
      'the bins': '{name} çöplerde nöbette',
      'the car port': '{name} otoparkta nöbette',
      'the square': '{name} meydanda nöbette',
      other: '{name} burada nöbette',
    },
    won: {
      'the bins': 'Çöpler artık senin',
      'the car port': 'Otopark artık senin',
      'the square': 'Meydan artık senin',
      other: 'Burası artık senin',
    },
  },

  names: {
    Rocket: 'Rocket',
    'Big Ginger': 'Koca Sarman',
    Duchess: 'Düşes',
    'The Colonel': 'Albay',
  },

  deeds: {
    tag: '{name} yakalandı',
    knock: 'Devirdin gitti',
    undercar: 'Arabanın altında',
    hedge: 'Çalının içinden',
    zoomies: 'Deli koşu',
    jump: 'Büyük atlayış',
    counter: 'İlk vuran sen',
    dodge: 'Iskalattın',
    turf: 'Bölge senin',
    flawless: 'Tek çizik yok',
    lostDuel: 'Dayak yedin',
    pigeons: 'Güvercinler dağıldı',
    meow: 'Selam verdin',
    climb: 'Ağacın tepesinde',
    mirror: 'Bu da kim?',
  },

  knocks: {
    pot: 'Saksı, yerle tanış',
    vase: 'Güzel bir vazoydu',
    gnome: 'Cüce yerde',
    can: 'Tenekeye tekme',
    bottle: 'Şişe bowlingi',
    ball: 'Top!',
    sign: 'Tabela yerle bir',
    lid: 'Çöp kapağı, gümm!',
  },

  ranks: ['Ev kedisi', 'Bahçe kâşifi', 'Sokak kedisi', 'Mahallenin belası', 'Site efsanesi', 'İnternet ünlüsü'],

  clipTitle: {
    pattern: '{name} {deeds}',
    comma: ', ',
    and: ' ve ',
    turfAll: 'bütün siteyi ele geçiriyor',
    turfOne: 'bir bölge savaşı kazanıyor',
    turfTwo: 'iki bölge savaşı kazanıyor',
    tag: 'sonunda kardeşini yakalıyor',
    chase: 'kendinden hızlı kardeşini kovalıyor',
    knocksMany: '{n} şey deviriyor',
    knocksFew: 'duvardan bir saksı düşürüyor',
    undercar: 'bir arabanın altına giriyor',
    quiet: 'sakin bir yürüyüşe çıkıyor',
  },

  lines: {
    idle: [
      'yere ne kadar yakın ya', 'çene kamerası beni bitirdi', 'nereye gidiyor bu', 'suç işlemek için ne güzel bir gün',
      'minik zilin sesi geliyor', 'bu hayvana kamerayı kim taktı', 'televizyondan iyi', 'neden gerildim ben',
      'şu bıyıklara bak', 'ilk', 'bu kararlılık ne', 'keşfete düşen en güzel şey', 'sabah sabah ne güzel içerik',
    ],
    chase: ['HADİ HADİ HADİ', 'yetişiyor', 'kardeşler işte.', 'tekir çok hızlı', 'bacaklar maşallah', 'YAKALA ONU', 'olimpiyat finali havası'],
    tag: ['YAKALADI', 'ebe sensin', 'adalet yerini buldu', 'rocket yıkıldı', 'bile bile yakalandı (hayır)'],
    knock: ['SAKSI OLMAZ', 'yer çekimi testi tamam', 'düşünce yok sadece it', 'önce baktı. taammüden.', 'bunu biri ödeyecek', 'klasik'],
    gnome: ['CÜCE', 'parçalar içinde yat küçük adam', 'cücenin ailesi vardı'],
    undercar: ['karardı', 'arabanın altına profesyonel giriş', 'kediler sıvıdır kanıtlandı', 'egzoza dikkat'],
    hedge: ['çalının içinden!!', 'her yer yaprak', 'kestirme açıldı', 'çalı: 0 kedi: 1'],
    zoomies: ['CİNLERİ TUTTU', 'son hız', 'biri durdursun şunu', 'on kedi gücünde'],
    jump: ['UÇTU', 'iniş on numara', 'parkur ustası'],
    slap: ['PAT', 'pat pat pat', 'tam burnuna', 'şaplak festivali'],
    counter: ['önce o vurdu!!', 'refleks bu', 'kitap gibi okudu'],
    dodge: ['matrix gibi kaçtı', 'kıl payı', 'yavaşsın'],
    playerHit: ['ah', 'bunu hissetti', 'silkelen geç', 'bu kişiseldi'],
    turf: ['YENİ KRAL', 'çöpler artık bizim', 'kaçtı!!', 'saygıyı hak etti', 'site artık onun'],
    lostDuel: ['bir daha deniyoruz', 'acı', 'o kedi spor salonuna gidiyor', 'taktik geri çekilme'],
    battery: ['pil bitiyor hayırrr', 'burada bitmesin', 'biri şu kediyi şarja taksın'],
    duelStart: ['eyvah', 'başlıyoruz', 'şu kedi pek huysuz', 'kapışın', 'kulaklar geride. olay çıkacak.'],
    pigeons: ['GÜVERCİNLER', 'bütün gün bunu yapmak istiyordu', 'kaos'],
    climb: ['NASIL inecek şimdi', 'biri itfaiyeyi arasın', 'oradan manzara şahanedir', 'ağaç kedisi', 'artık orada yaşıyor'],
    blocked: ['savuşturdu', 'çırpınma artık!!', 'bekle bekle', 'sabır küçük kaplan'],
    rivalWinded: ['nefesi kesildi, VUR', 'şimdi şimdi şimdi', 'nefes nefese kaldı asdfgh'],
    meow: ['selam verdi', 'MİYAV', 'bugün pek konuşkan', 'biri çevirsin şunu', 'kardeşini çağırıyor'],
    mirror: [
      'KENDİNİ GÖRDÜ', 'kim bu yakışıklı kedi', 'öbür kedinin de kamerası var', 'kendisi olduğunu bilmiyor',
      'ana karakter anı', 'kendisiyle bakışma yarışında', 'kapıdaki kedi başlattı',
    ],
  },
};

export default tr;
