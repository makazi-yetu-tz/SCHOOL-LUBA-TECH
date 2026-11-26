# SCHOOL LUBA TECH - mfumo wa shule

## FAILI MOJA

**`school-luba-tech.js`** ndilo faili kamili: seva + ukurasa wote (HTML, CSS, JS, lugha mbili) vimo ndani. Hakuna folda nyingine, hakuna `npm install` (Node 18+).

```bash
# Majaribio kwenye kompyuta yako
ALLOW_MOCK=1 ADMIN_KEY=weka-neno-refu-16-herufi node school-luba-tech.js    # http://localhost:3000

# Uzalishaji (production): angalia .env.example
NODE_ENV=production SESSION_SECRET=... ADMIN_KEY=... WEBHOOK_SECRET=... GATEWAY=<yako> SMS_PROVIDER=beem BEEM_API_KEY=... BEEM_SECRET=... APP_URL=https://... VIDEO_URL=https://.../video.mp4 node school-luba-tech.js
```

Seva haiwaki kwenye hali isiyo salama: gateway bandia/SMS ya console bila `ALLOW_MOCK=1`, production bila `SESSION_SECRET` (herufi 32+), au `ADMIN_KEY` fupi (chini ya 16).

Kujenga upya faili moja kutoka kwa vyanzo (`server.js` + `public/index.html`): `node build.js`. Kujaribu: `node test.js` (majaribio 80) au `SERVER_FILE=school-luba-tech.js node test.js`.

## Watoa huduma (NextSMS na DaliPay)
- SMS: `SMS_PROVIDER=nextsms` + `NEXTSMS_USERNAME`, `NEXTSMS_PASSWORD`, `NEXTSMS_SENDER`.
- Malipo: `GATEWAY=dalipay` + `DALIPAY_PUBLIC_KEY`, `DALIPAY_SECRET_KEY`. Kwenye Settings za DaliPay weka webhook `https://DOMAIN-YAKO/api/webhook/dalipay`.
- Malipo yanathibitishwa tu DaliPay ikisema "success" kwa ombi la seva-hadi-seva; webhook ni ishara tu na haiaminiki yenyewe, kwa hiyo webhook ya uongo haiwezi kuongeza pesa.
- **Muhimu:** njia (paths) na majina ya headers ya DaliPay (`/collections`, `X-Public-Key`, `X-Secret-Key`) ni makisio kutoka SDK yao; hayajajaribiwa na akaunti halisi. Yabadilishe kwa env (`.env.example`) kulingana na nyaraka zako. Majaribio: `node test-providers.js` (seva bandia).

## OTP na usalama (muhimu)
- **OTP kwenye usajili wa shule na mzazi**: mtu hawezi kutumia namba ya mtu mwingine. OTP inatumwa mara moja kwa SMS, na skrini inaonyesha namba iliyotumiwa. Inaisha dakika 5, majaribio 5, inatumika mara moja; makosa 10 yanafunga namba saa 1.
- **Mkuu wa shule** anabadilisha namba ya kuingia na namba ya kupokea malipo; **mzazi** anabadilisha namba ya kuingia: kila mabadiliko yanahitaji nenosiri + OTP iliyotumwa kwa namba MPYA.
- **SMS ya kukaribisha** inatumwa kwa shule mara baada ya usajili (namba tayari imethibitishwa kwa OTP).
- SMS za kuandika mwenyewe zinakwenda kwa wazazi waliothibitishwa kwa OTP tu (si kwa namba zilizoandikwa na shule). Majina hayaruhusiwi kuwa na kiungo, barua pepe au namba ndefu (kuzuia SMS za kuhadaa). Kuna vikomo vya OTP kwa namba/IP/siku, na ukurasa unapakiwa kwa gzip (haraka).
- Namba ya Team Support: 0667061999 (chini ya kila ukurasa).

## Vipengele vipya
- **Jina la moto**: SCHOOL LUBA TECH, herufi zinaruka moja moja kisha zote zinakaa sawa kwa sekunde ~3, moto/mshumaa unazimika na kuwaka; kurudia.
- **Badili Lugha / Change Language** kwenye kila skrini: mzazi, shule na admin (Kiswahili/English, inakumbukwa). SMS zinabaki Kiswahili.
- **Umesahau nenosiri** (OTP kwa SMS, dakika 5, majaribio 5, mara moja tu). Nenosiri jipya linaua vikao vya zamani. Nenosiri angalau herufi 8.
- **Admin** (ufunguo wa mmiliki, haihifadhiwi kwenye kivinjari): jumla, shule, ukomo wa SMS, maombi ya kutoa pesa.
- **Hakuna uthibitisho wa shule**: shule ikijisajili inafanya kazi mara moja. **SMS**: ujumbe kwa wazazi wote unaruhusiwa mara 2 kwa wiki na 8 kwa mwezi kwa kila shule (ripoti ya waliotumiwa inaonekana papo hapo); kumtumia mzazi mmoja (kwa kuchagua kwenye orodha) hakuhesabiwi. Kuzuia spam: namba moja haipokei zaidi ya SMS 3 kwa saa 24 kutoka shule zote, mwaliko mmoja kwa namba kwa siku 7, na ukomo wa usajili/madarasa/walimu/wanafunzi.
- **Team Support**: namba 0667061999 inaonekana chini ya kila ukurasa.
- **Malipo**: pesa ya wazazi (TSh 1,000) inaingia moja kwa moja kwenye akaunti yako ya DaliPay. Shule inaona 35% kama salio, inaomba kutoa, wewe unaona ombi kwenye Admin, unalipa kwa njia ya kawaida (nje ya mfumo) kisha unabonyeza "Nimeshalipa". Ukikataa, salio linarudi.
- **Namba ya kupokea malipo ya shule** inabadilishwa wakati wowote (inahitaji nenosiri). **Mzazi** anaweza kubadilisha namba ya kuingia na kulipia kwa namba tofauti.
- **Admin** anaona kila shule: wanafunzi waliolipa/wasiolipa, makusanyo, 35%, waliolipwa, salio na namba ya malipo.
- **Video** ya ukurasa wa mbele inatoka `VIDEO_URL` (inacheza na sauti).

## Mtiririko

1. **Shule** inajisajili (jina la shule la kipekee, msimamizi, simu, nenosiri).
2. Shule inaongeza **madarasa**, **ratiba** za kila darasa (siku, saa, somo, mwalimu), **walimu** (jina + simu, bila akaunti), na **wanafunzi** (namba, jina, darasa, tarehe ya kuzaliwa).
3. **Mzazi** anajisajili kwa jina la shule + namba ya mwanafunzi + tarehe ya kuzaliwa; yote lazima yalingane. Anaona ratiba ya darasa na matokeo.
4. Jaribio la bure saa 24; baada ya hapo matokeo yamefungwa hadi alipie (ratiba haifungwi).
5. Malipo TSh 1,000 kwa siku 30; yakithibitishwa **shule inapata 35%** (TSh 350), mara moja tu kwa kila malipo.
6. Shule inaomba kutoa pesa (kuanzia TSh 3,500). Ombi linakuwa `pending`; wewe (mmiliki) unalipa kisha unaliweka alama kama limelipwa.

## Picha, miamala na mwaliko

- **Picha za wanafunzi:** shule inaweka picha ya kila mwanafunzi (📷 kwenye orodha), na mzazi anaweza kuweka au kubadilisha picha ya mtoto wake kwenye dashibodi yake. Picha inapunguzwa ukubwa kwenye simu kabla ya kutumwa (400px), inakaguliwa kwenye seva (JPG/PNG/WEBP pekee, kiwango cha juu 400KB), na inaonekana kwa shule ya mwanafunzi huyo na mzazi wake tu. Picha zinahifadhiwa kwenye `data/photos/`; zichukue backup pamoja na `db.json`.
- **Miamala:** dashibodi ya shule ina "Miamala ya Wazazi": kila malipo (mwanafunzi, mzazi, kiasi, hali, tarehe, namba ya rejea), jumla iliyolipwa na kamisheni ya 35%.
- **Mwaliko wa SMS:** shule inaweza kuweka simu ya mzazi wakati wa kuongeza mwanafunzi. Kitufe "Alika Wazazi Wasiojisajili" kinatuma SMS yenye kiungo cha mfumo na namba ya mwanafunzi kwa wasiojisajili tu, mara moja kwa saa 24 kwa kila mzazi. Weka `APP_URL` (kiungo halisi cha mfumo) kwenye mazingira.

## SMS: wewe ndiye unanunua, shule inatuma tu

- Akaunti moja ya mtoa huduma (Beem) ni yako. Shule hazihitaji kununua chochote.
- SMS zinatumwa **otomatiki**: matokeo yakihifadhiwa (kwa mzazi wa mwanafunzi huyo), ratiba ikibadilishwa (hiari), na SMS za shule kwa wazazi wote / darasa moja / walimu / wote.
- Kila shule ina **ukomo wa SMS kwa mwezi** (`SMS_QUOTA_DEFAULT`, chaguo-msingi 300). Ukomo ukiisha, SMS zinakataliwa au kurukwa; matokeo bado yanahifadhiwa.
- OTP ya kusahau nenosiri haikatwi kwenye ukomo wa shule.
- Mzazi ambaye jaribio limeisha bila kulipa hapati alama kwenye SMS; anaelekezwa kulipia.
- Gharama ya SMS ni yako: hakiki bei za mtoa huduma, na uweke ukomo unaolingana na mapato (65% ya TSh 1,000 kwa mwanafunzi).

## Admin (wewe mmiliki)

Weka `ADMIN_KEY` kwenye mazingira, kisha tumia header `x-admin-key`:

```bash
curl -H "x-admin-key: $ADMIN_KEY" http://localhost:3000/api/admin/overview
curl -X POST -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
     -d '{"schoolId":"<id>","quota":1000}' http://localhost:3000/api/admin/quota
curl -X POST -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
     -d '{"id":"<withdrawal id>"}' http://localhost:3000/api/admin/withdrawals/paid
```

## Kinachobaki kabla ya kupokea pesa halisi

- **Gateway**: andika adapter ya mtoa huduma uliyemchagua ndani ya `gateways()` (`initiate()` inaanzisha USSD push) na ubadilishe uthibitishaji wa webhook (`/api/webhook/payment`) ulingane na saini ya mtoa huduma huyo. Seva inakataa kuanza kwa `NODE_ENV=production` ikiwa `GATEWAY=mock`.
- **Payout ya kamisheni kwa shule**: bado ni ya mkono (admin anaweka alama baada ya kulipa), au tumia gateway ya disbursement.
- **SMS ya Beem**: msimbo upo (`SMS_PROVIDER=beem`) lakini haujajaribiwa na akaunti halisi. Hakiki dhidi ya nyaraka za Beem na uweke Sender ID iliyoidhinishwa.
- **OTP kwa WhatsApp**: bado.
- **Hifadhidata**: JSON faili linatosha kuanzia; kwa shule nyingi hamia Postgres, na ufanye backup ya `data/db.json`.
- **HTTPS**: weka nyuma ya nginx/Caddy/Cloudflare na `TRUST_PROXY=1`.
- **Faragha**: unahifadhi taarifa za watoto; angalia sheria ya ulinzi wa data binafsi ya Tanzania (PDPA 2022) na uweke sera ya faragha.

## Kupakia GitHub na kuendesha

1. Pakia faili zote za folda hii kwenye repo yako ya GitHub (`.env` na `data/` havipakiwi, vimo kwenye `.gitignore`).
2. Kwenye seva/hosting (Render, Railway, VPS n.k.): `npm start` (inaendesha `school-luba-tech.js`, hakuna `npm install` inayohitajika).
3. Weka vigezo kutoka `.env.example` kwenye mipangilio ya hosting (siyo kwenye GitHub): `SESSION_SECRET`, `ADMIN_KEY`, NextSMS, DaliPay, `NODE_ENV=production`.
4. Hifadhi data kwenye diski ya kudumu: weka `DATA_FILE=/njia/ya/diski/db.json` (picha huhifadhiwa kando yake kwenye `photos/`). Bila hili data inaweza kupotea hosting ikianzishwa upya.

## Video na Wimbo wa Taifa
Admin anapakia video (MP4/WEBM, hadi 30MB; inachezwa sekunde 30 za kwanza) na Wimbo wa Taifa (MP3/M4A/OGG/WAV, hadi 12MB) kwenye ukurasa wa Admin. Faili zinahifadhiwa kando ya `DATA_FILE` kwenye folda ya `media/`.
