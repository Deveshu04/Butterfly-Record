// Fixture content for mock mode. Nothing here ships: see mock.ts.

export interface Scene {
  /** Desktop colour behind the window. */
  backdrop: string
  /** Accent used inside the pictured app. */
  tint: string
  kind: 'app' | 'call' | 'slides' | 'code'
}

export interface MockVideo {
  title: string
  description: string
  /** Minutes before "now" the recording was made. */
  ageMinutes: number
  duration: number
  width: number
  height: number
  frameRate: number
  scene: Scene
  surface: 'display' | 'window'
  sourceLabel: string
  mic: string | null
  systemAudio: boolean
  imported?: { path: string }
  needsRecovery?: boolean
  transcript?: 'planning'
  pendingTranscription?: boolean
}

export const ROOT = 'C:\\Users\\Asha\\Videos\\Butterfly Record'

export const VIDEOS: MockVideo[] = [
  {
    title: 'Quarterly planning review',
    description:
      'Planning for the next quarter: hiring two support engineers, moving the billing migration to week six, and the Hindi and Tamil launch for the mobile app.',
    ageMinutes: 95,
    duration: 252,
    width: 1920,
    height: 1080,
    frameRate: 30,
    scene: { backdrop: '#5b6b7a', tint: '#3f6fa8', kind: 'slides' },
    surface: 'display',
    sourceLabel: 'Entire screen',
    mic: 'Microphone (Jabra Evolve2 65)',
    systemAudio: true,
    transcript: 'planning',
  },
  {
    title: 'Onboarding walkthrough: expense tool',
    description: '',
    ageMinutes: 60 * 26,
    duration: 465,
    width: 1920,
    height: 1080,
    frameRate: 30,
    scene: { backdrop: '#6f7f6a', tint: '#4b7d5a', kind: 'app' },
    surface: 'window',
    sourceLabel: 'Expenses – Microsoft Edge',
    mic: 'Microphone (Realtek(R) Audio)',
    systemAudio: false,
    pendingTranscription: true,
  },
  {
    title: 'Customer call highlights',
    description: '',
    ageMinutes: 60 * 30,
    duration: 723,
    width: 1280,
    height: 720,
    frameRate: 25,
    scene: { backdrop: '#2f3338', tint: '#7a6a8c', kind: 'call' },
    surface: 'display',
    sourceLabel: 'Customer call highlights.mp4',
    mic: null,
    systemAudio: false,
    imported: { path: 'D:\\Clients\\Northwind\\Customer call highlights.mp4' },
  },
  {
    title: 'Recording 2026-10-05 16.42',
    description: '',
    ageMinutes: 60 * 24 * 2 + 200,
    duration: 0,
    width: 1920,
    height: 1080,
    frameRate: 30,
    scene: { backdrop: '#7a6a5f', tint: '#8a5a3c', kind: 'app' },
    surface: 'display',
    sourceLabel: 'Entire screen',
    mic: 'Microphone (Realtek(R) Audio)',
    systemAudio: false,
    needsRecovery: true,
  },
  {
    title: 'Bug repro: export dialog freezes',
    description: 'Steps: open a long project, choose Export, switch to PDF. The dialog stops responding after about four seconds.',
    ageMinutes: 60 * 24 * 4 + 30,
    duration: 97,
    width: 2560,
    height: 1440,
    frameRate: 60,
    scene: { backdrop: '#5f7b7b', tint: '#2f6f73', kind: 'code' },
    surface: 'window',
    sourceLabel: 'Visual Studio Code',
    mic: 'Microphone (Realtek(R) Audio)',
    systemAudio: false,
  },
  {
    title: 'Design review: settings page',
    description: '',
    ageMinutes: 60 * 24 * 9,
    duration: 542,
    width: 1920,
    height: 1080,
    frameRate: 30,
    scene: { backdrop: '#6d6680', tint: '#5d4f8a', kind: 'app' },
    surface: 'display',
    sourceLabel: 'Entire screen',
    mic: 'Microphone (Jabra Evolve2 65)',
    systemAudio: true,
  },
  {
    title: 'Sprint 41 demo',
    description: 'Search filters, saved views and the new export queue.',
    ageMinutes: 60 * 24 * 33,
    duration: 920,
    width: 1920,
    height: 1080,
    frameRate: 30,
    scene: { backdrop: '#8c8270', tint: '#7a5f2f', kind: 'slides' },
    surface: 'display',
    sourceLabel: 'Entire screen',
    mic: 'Microphone (Jabra Evolve2 65)',
    systemAudio: true,
  },
]

/** [speaker index, English, Hindi] — 40 lines, about 6.3 s each over 4:12. */
export const PLANNING_LINES: ReadonlyArray<readonly [0 | 1, string, string]> = [
  [0, 'Okay, I think everyone is here, so let’s get started.', 'ठीक है, मुझे लगता है सब आ गए हैं, तो चलिए शुरू करते हैं।'],
  [0, 'The goal today is to agree on priorities for next quarter.', 'आज का लक्ष्य अगली तिमाही की प्राथमिकताओं पर सहमति बनाना है।'],
  [1, 'Before we start, can we look at where support volume ended up?', 'शुरू करने से पहले, क्या हम देख सकते हैं कि सपोर्ट वॉल्यूम कहाँ पहुँचा?'],
  [0, 'Sure. Tickets were up about eighteen percent over the last quarter.', 'ज़रूर। पिछली तिमाही में टिकट लगभग अठारह प्रतिशत बढ़े।'],
  [0, 'Most of that came from the billing changes in August.', 'इसका ज़्यादातर हिस्सा अगस्त के बिलिंग बदलावों से आया।'],
  [1, 'That matches what the team has been telling me.', 'टीम भी मुझे यही बता रही है।'],
  [1, 'Response times slipped to almost six hours on weekdays.', 'कार्यदिवसों में जवाब देने का समय लगभग छह घंटे तक पहुँच गया।'],
  [0, 'Which is why the first item on the list is hiring.', 'इसीलिए सूची में पहला विषय भर्ती है।'],
  [0, 'I’d like to open two support engineer roles in October.', 'मैं अक्टूबर में सपोर्ट इंजीनियर के दो पद खोलना चाहता हूँ।'],
  [1, 'Two is right. One would only cover the backlog.', 'दो सही हैं। एक से सिर्फ़ बकाया काम निपटेगा।'],
  [1, 'Can we make one of them someone who speaks Tamil?', 'क्या उनमें से एक तमिल बोलने वाला हो सकता है?'],
  [0, 'Yes, that fits well with the language launch later on.', 'हाँ, यह बाद वाले भाषा लॉन्च के साथ अच्छी तरह मेल खाता है।'],
  [0, 'Second item is the billing migration.', 'दूसरा विषय बिलिंग माइग्रेशन है।'],
  [0, 'We planned it for week three, but I don’t think that’s realistic.', 'हमने इसे तीसरे हफ़्ते के लिए रखा था, पर मुझे यह व्यावहारिक नहीं लगता।'],
  [1, 'What’s blocking it?', 'इसमें रुकावट क्या है?'],
  [0, 'Mostly the invoice exports. Finance needs a full month of parallel runs.', 'मुख्य रूप से इनवॉइस एक्सपोर्ट। फ़ाइनेंस को पूरे एक महीने के समानांतर रन चाहिए।'],
  [1, 'Then let’s move it to week six and say so clearly.', 'तो इसे छठे हफ़्ते पर ले चलते हैं और यह साफ़ बता देते हैं।'],
  [1, 'I’d rather be late on purpose than late by surprise.', 'अचानक देर होने से अच्छा है कि हम सोच-समझकर देर करें।'],
  [0, 'Agreed. I’ll update the customer notice this week.', 'सहमत। मैं इसी हफ़्ते ग्राहक सूचना अपडेट कर दूँगा।'],
  [0, 'Third is the mobile app in Hindi and Tamil.', 'तीसरा विषय हिंदी और तमिल में मोबाइल ऐप है।'],
  [1, 'Where are we on translations?', 'अनुवाद का काम कहाँ तक पहुँचा?'],
  [0, 'Hindi strings are done. Tamil is about seventy percent.', 'हिंदी स्ट्रिंग्स पूरी हो गई हैं। तमिल लगभग सत्तर प्रतिशत है।'],
  [0, 'Reviewers start on the remaining screens next Monday.', 'समीक्षक बाकी स्क्रीन पर अगले सोमवार से काम शुरू करेंगे।'],
  [1, 'And the help videos? Those matter more than the screens.', 'और सहायता वीडियो? वे स्क्रीन से ज़्यादा ज़रूरी हैं।'],
  [0, 'We’re recording them in English and dubbing them.', 'हम उन्हें अंग्रेज़ी में रिकॉर्ड करके डब कर रहे हैं।'],
  [0, 'The first two dubbed versions came back yesterday.', 'पहले दो डब किए गए वीडियो कल वापस आ गए।'],
  [1, 'How do they sound?', 'वे सुनने में कैसे हैं?'],
  [0, 'Honestly, better than I expected. The voices still sound like us.', 'सच कहूँ तो उम्मीद से बेहतर। आवाज़ें अब भी हमारी ही लगती हैं।'],
  [1, 'Good. Let’s get a native speaker to check every one before release.', 'अच्छा। रिलीज़ से पहले हर एक को किसी मूल भाषी से जँचवा लेते हैं।'],
  [0, 'That’s already in the plan for both languages.', 'यह दोनों भाषाओं के लिए पहले से योजना में है।'],
  [0, 'Last item is the dashboard performance work.', 'आख़िरी विषय डैशबोर्ड के प्रदर्शन का काम है।'],
  [1, 'Can that wait until after the launch?', 'क्या वह लॉन्च के बाद तक रुक सकता है?'],
  [0, 'Partly. The slow reports affect our three biggest customers.', 'आंशिक रूप से। धीमी रिपोर्ट हमारे तीन सबसे बड़े ग्राहकों को प्रभावित करती हैं।'],
  [0, 'I’d fix those two reports now and leave the rest.', 'मैं उन दो रिपोर्टों को अभी ठीक करूँगा और बाकी को छोड़ दूँगा।'],
  [1, 'That sounds like the right trade-off.', 'यह सही संतुलन लगता है।'],
  [1, 'So: two hires, billing in week six, launch on track, two reports.', 'तो: दो भर्तियाँ, छठे हफ़्ते में बिलिंग, लॉन्च समय पर, और दो रिपोर्ट।'],
  [0, 'Yes. I’ll write it up and share it this afternoon.', 'हाँ। मैं इसे लिखकर आज दोपहर साझा कर दूँगा।'],
  [1, 'Please include the dates for the customer notice.', 'कृपया ग्राहक सूचना की तारीख़ें भी शामिल करें।'],
  [0, 'Will do. Thanks, everyone.', 'ज़रूर। सभी का धन्यवाद।'],
  [1, 'Thanks. Talk next week.', 'धन्यवाद। अगले हफ़्ते बात करते हैं।'],
]

/** Generic lines for transcripts produced while the mock runs. */
export const FILLER_LINES = [
  'Let me share my screen so you can follow along.',
  'This is the page most people land on first.',
  'You can filter the list from the panel on the left.',
  'Notice how the totals update as soon as you change a value.',
  'I’ll open the settings to show where this is configured.',
  'Here is the part that usually causes confusion.',
  'If you save now, the change applies to every report.',
  'That’s the main flow. Questions are welcome at the end.',
]
