import {
  aiPickBestMatch,
  aiBatchPickBestMatches,
  buildAiMatchPrompt,
  buildAiBatchMatchPrompt,
  AI_MATCH_SCHEMA,
  AI_MATCH_SYSTEM_PROMPT,
  BATCH_AI_MATCH_SCHEMA,
  BATCH_AI_MATCH_SYSTEM_PROMPT,
  AiMatchTarget,
  AiMatchCandidate,
  AiBatchMatchRequestItem,
} from '../aiMatcher';
import type { AiProxyConfig } from '../aiProxy';

const mockProxy: AiProxyConfig = {
  url: 'https://test-ai-proxy.workers.dev/chat',
  token: 'mock-token-1234567890',
};

const sampleTarget: AiMatchTarget = {
  name: 'Coca-Cola Original Taste Soft Drink',
  brand: 'Coca-Cola',
  unit: '750 ml',
  price: 40,
  mrp: 45,
  platform: 'blinkit',
};

const sampleCandidates: AiMatchCandidate[] = [
  {
    id: 'c1',
    title: 'Coke Bottle',
    brand: 'Coca-Cola',
    quantity: '750 ml',
    price: 40,
    originalPrice: 45,
    platform: 'swiggy',
    inStock: true,
  },
  {
    id: 'c2',
    title: 'Thums Up',
    brand: 'Thums Up',
    quantity: '750 ml',
    price: 40,
    platform: 'swiggy',
    inStock: true,
  },
];

describe('aiMatcher: buildAiMatchPrompt', () => {
  it('formats target details with name, brand, volume/weight/pieces, price, and MRP', () => {
    const prompt = buildAiMatchPrompt(sampleTarget, sampleCandidates, 'Instamart');
    expect(prompt).toContain('Selected Product (from blinkit):');
    expect(prompt).toContain('Coca-Cola Original Taste Soft Drink');
    expect(prompt).toContain('Brand: Coca-Cola');
    expect(prompt).toContain('Pack size / Volume / Weight / Pieces: 750 ml');
    expect(prompt).toContain('Price: ₹40 (MRP: ₹45)');
  });

  it('formats candidate options with title, brand, size/volume/pieces, price, and stock', () => {
    const prompt = buildAiMatchPrompt(sampleTarget, sampleCandidates, 'Instamart');
    expect(prompt).toContain('Candidate Options from Instamart:');
    expect(prompt).toContain('[0] Title: "Coke Bottle", Brand: "Coca-Cola", Size/Weight/Volume/Pieces: "750 ml", Price: ₹40 (MRP: ₹45)');
    expect(prompt).toContain('[1] Title: "Thums Up", Brand: "Thums Up", Size/Weight/Volume/Pieces: "750 ml", Price: ₹40');
  });

  it('handles targets with missing brand, mrp, or unit gracefully', () => {
    const minimalTarget: AiMatchTarget = {
      name: 'Organic Honey',
      price: 250,
    };
    const minimalCandidate: AiMatchCandidate = {
      title: 'Honey Pure',
      price: 260,
    };
    const prompt = buildAiMatchPrompt(minimalTarget, [minimalCandidate]);
    expect(prompt).toContain('Name: Organic Honey');
    expect(prompt).toContain('Pack size: Not specified');
    expect(prompt).toContain('Price: ₹250');
    expect(prompt).toContain('[0] Title: "Honey Pure", Price: ₹260');
  });
});

describe('aiMatcher: aiPickBestMatch', () => {
  it('returns null immediately when candidates array is empty', async () => {
    const chat = jest.fn();
    const res = await aiPickBestMatch({
      target: sampleTarget,
      candidates: [],
      deps: { proxy: mockProxy, chat },
    });
    expect(res).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });

  it('returns null when proxy is not configured', async () => {
    const chat = jest.fn();
    const res = await aiPickBestMatch({
      target: sampleTarget,
      candidates: sampleCandidates,
      deps: { proxy: null, chat },
    });
    expect(res).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });

  it('returns a match decision when Groq picks candidate 0', async () => {
    const chat = jest.fn().mockResolvedValue({
      matchFound: true,
      candidateIndex: 0,
      confidence: 0.98,
      reason: 'Coke Bottle 750ml matches Coca-Cola Original 750ml.',
    });

    const res = await aiPickBestMatch({
      target: sampleTarget,
      candidates: sampleCandidates,
      targetPlatform: 'swiggy',
      deps: { proxy: mockProxy, chat },
    });

    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      proxy: mockProxy,
      schemaName: 'ai_match_decision',
      schema: AI_MATCH_SCHEMA,
      system: AI_MATCH_SYSTEM_PROMPT,
    }));
    expect(res).toEqual({
      matchFound: true,
      candidateIndex: 0,
      confidence: 0.98,
      reason: 'Coke Bottle 750ml matches Coca-Cola Original 750ml.',
    });
  });

  it('matches equivalent products of different brands when price range and pack size align (e.g. eggs)', async () => {
    const eggTarget: AiMatchTarget = {
      name: 'Fresh Eggs White eggs',
      unit: '6 pcs',
      price: 55,
      platform: 'blinkit',
    };
    const eggCandidates: AiMatchCandidate[] = [
      {
        id: 'e1',
        title: 'Eggoz Farm Fresh White Eggs',
        brand: 'Eggoz',
        quantity: '6 pcs',
        price: 58,
        platform: 'swiggy',
      },
    ];

    const chat = jest.fn().mockResolvedValue({
      matchFound: true,
      candidateIndex: 0,
      confidence: 0.95,
      reason: 'Same pack size 6 pcs white eggs and similar price.',
    });

    const res = await aiPickBestMatch({
      target: eggTarget,
      candidates: eggCandidates,
      targetPlatform: 'swiggy',
      deps: { proxy: mockProxy, chat },
    });

    expect(res).toEqual({
      matchFound: true,
      candidateIndex: 0,
      confidence: 0.95,
      reason: 'Same pack size 6 pcs white eggs and similar price.',
    });
  });

  it('handles negative decision when no candidate matches', async () => {
    const chat = jest.fn().mockResolvedValue({
      matchFound: false,
      candidateIndex: null,
      confidence: 0,
      reason: 'None of the candidates are Coca-Cola.',
    });

    const res = await aiPickBestMatch({
      target: sampleTarget,
      candidates: sampleCandidates,
      deps: { proxy: mockProxy, chat },
    });

    expect(res).toEqual({
      matchFound: false,
      candidateIndex: null,
      confidence: 0,
      reason: 'None of the candidates are Coca-Cola.',
    });
  });

  it('safely handles out-of-bounds candidateIndex from LLM', async () => {
    const chat = jest.fn().mockResolvedValue({
      matchFound: true,
      candidateIndex: 99,
      confidence: 0.9,
      reason: 'Invalid candidate index',
    });

    const res = await aiPickBestMatch({
      target: sampleTarget,
      candidates: sampleCandidates,
      deps: { proxy: mockProxy, chat },
    });

    expect(res).toEqual({
      matchFound: false,
      candidateIndex: null,
      confidence: 0,
      reason: 'Invalid candidate index',
    });
  });

  it('safely catches errors and returns null without throwing', async () => {
    const chat = jest.fn().mockRejectedValue(new Error('Network error'));

    const res = await aiPickBestMatch({
      target: sampleTarget,
      candidates: sampleCandidates,
      deps: { proxy: mockProxy, chat },
    });

    expect(res).toBeNull();
  });
});

describe('aiMatcher: aiBatchPickBestMatches', () => {
  const batchItem0: AiBatchMatchRequestItem = {
    itemIndex: 0,
    target: sampleTarget,
    candidates: sampleCandidates,
    targetPlatform: 'swiggy',
  };

  const batchItem1: AiBatchMatchRequestItem = {
    itemIndex: 1,
    target: {
      name: 'Amul Salted Butter',
      brand: 'Amul',
      unit: '500 g',
      price: 275,
      platform: 'blinkit',
    },
    candidates: [
      { id: 'b1', title: 'Amul Butter 500g', price: 275, platform: 'swiggy' },
    ],
    targetPlatform: 'swiggy',
  };

  it('buildAiBatchMatchPrompt formats all items and their candidates', () => {
    const prompt = buildAiBatchMatchPrompt([batchItem0, batchItem1]);
    expect(prompt).toContain('=== ITEM [0] ===');
    expect(prompt).toContain('Coca-Cola');
    expect(prompt).toContain('=== ITEM [1] ===');
    expect(prompt).toContain('Amul Salted Butter');
    expect(prompt).toContain('Amul Butter 500g');
  });

  it('returns an empty map when items list is empty or has no candidates', async () => {
    const chat = jest.fn();
    const res = await aiBatchPickBestMatches({
      items: [{ itemIndex: 0, target: sampleTarget, candidates: [] }],
      deps: { proxy: mockProxy, chat },
    });
    expect(res.size).toBe(0);
    expect(chat).not.toHaveBeenCalled();
  });

  it('batches multiple items into a single Groq request', async () => {
    const chat = jest.fn().mockResolvedValue({
      matches: [
        {
          itemIndex: 0,
          matchFound: true,
          candidateIndex: 0,
          confidence: 0.95,
          reason: 'Coke Bottle matches Coca-Cola Original',
        },
        {
          itemIndex: 1,
          matchFound: true,
          candidateIndex: 0,
          confidence: 0.99,
          reason: 'Exact same Amul butter 500g',
        },
      ],
    });

    const res = await aiBatchPickBestMatches({
      items: [batchItem0, batchItem1],
      deps: { proxy: mockProxy, chat },
    });

    expect(chat).toHaveBeenCalledTimes(1); // EXACTLY ONE CALL FOR MULTIPLE PRODUCTS
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      proxy: mockProxy,
      schemaName: 'ai_batch_match_decision',
      schema: BATCH_AI_MATCH_SCHEMA,
      system: BATCH_AI_MATCH_SYSTEM_PROMPT,
    }));

    expect(res.size).toBe(2);
    expect(res.get(0)).toEqual({
      matchFound: true,
      candidateIndex: 0,
      confidence: 0.95,
      reason: 'Coke Bottle matches Coca-Cola Original',
    });
    expect(res.get(1)).toEqual({
      matchFound: true,
      candidateIndex: 0,
      confidence: 0.99,
      reason: 'Exact same Amul butter 500g',
    });
  });

  it('safely handles non-matches and out of bounds indices in batch mode', async () => {
    const chat = jest.fn().mockResolvedValue({
      matches: [
        {
          itemIndex: 0,
          matchFound: false,
          candidateIndex: null,
          confidence: 0,
          reason: 'None match',
        },
        {
          itemIndex: 1,
          matchFound: true,
          candidateIndex: 999, // out of bounds
          confidence: 0.9,
          reason: 'Invalid candidate index',
        },
      ],
    });

    const res = await aiBatchPickBestMatches({
      items: [batchItem0, batchItem1],
      deps: { proxy: mockProxy, chat },
    });

    expect(res.get(0)?.matchFound).toBe(false);
    expect(res.get(1)?.matchFound).toBe(false);
  });
});
