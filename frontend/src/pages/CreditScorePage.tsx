import { useQuery } from '@tanstack/react-query';
import { useWalletStore } from '../store/walletStore';
import { API_URL } from '../config/stellar';

async function fetchCreditScore(publicKey: string, token?: string | null) {
  const headers: HeadersInit = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${API_URL}/api/credit-score/${publicKey}`, { headers });
  if (!res.ok) throw new Error('Failed to fetch credit score');
  return res.json();
}

function scoreLabel(score: number) {
  if (score >= 80) return { label: 'Excellent', color: 'text-green-600', description: 'Lowest interest rates, zero collateral required' };
  if (score >= 70) return { label: 'Good', color: 'text-blue-600', description: 'Competitive interest rates, zero collateral required' };
  if (score >= 60) return { label: 'Fair', color: 'text-yellow-600', description: 'Standard interest rates, eligible for unsecured borrowing' };
  if (score >= 50) return { label: 'Poor', color: 'text-orange-600', description: 'Collateral required for borrowing (score < 60)' };
  return { label: 'Very Poor', color: 'text-red-600', description: 'Ineligible for direct loans (minimum score 50 required)' };
}

export function CreditScorePage() {
  const { publicKey, getAuthToken } = useWalletStore();
  const token = getAuthToken();

  const { data, isLoading, error } = useQuery({
    queryKey: ['credit-score', publicKey],
    queryFn: () => fetchCreditScore(publicKey!, token),
    enabled: !!publicKey,
  });

  const score = data?.data?.score ?? 0;
  const { label, color, description } = scoreLabel(score);

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Decentralized Credit Score</h1>
      <p className="text-sm text-gray-500 mb-6">
        Authoritative 0–100 scale computed deterministically from on-chain payment history, savings, and community vouches.
      </p>

      {isLoading && <p className="text-gray-500">Loading credit score from network…</p>}
      {Boolean(error) && <p className="text-red-500">Failed to load credit score from blockchain.</p>}

      {data && (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center shadow-sm">
          <div className="inline-block p-6 rounded-full bg-gray-50 border border-gray-100 mb-4">
            <p className={`text-6xl font-extrabold ${color}`}>{score}</p>
            <p className="text-xs text-gray-400 mt-1">out of 100</p>
          </div>
          <p className={`text-2xl font-bold ${color}`}>{label}</p>
          <p className="text-sm text-gray-600 mt-1">{description}</p>

          <div className="mt-8 grid grid-cols-2 gap-4 text-left">
            {[
              { label: 'Payment Consistency', value: data.data?.payment_history_score, weight: '40%' },
              { label: 'Savings Longevity', value: data.data?.savings_score, weight: '30%' },
              { label: 'Community Vouches', value: data.data?.community_score, weight: '20%' },
              { label: 'Account Activity', value: data.data?.activity_score, weight: '10%' },
            ].map((item) => (
              <div key={item.label} className="bg-gray-50 rounded-lg p-4 border border-gray-100">
                <div className="flex justify-between items-center mb-1">
                  <p className="text-xs text-gray-500 font-medium">{item.label}</p>
                  <span className="text-[10px] text-gray-400 font-mono">{item.weight}</span>
                </div>
                <p className="text-2xl font-bold text-gray-900">{item.value ?? 0}</p>
              </div>
            ))}
          </div>

          <div className="mt-8 p-4 bg-indigo-50 rounded-lg border border-indigo-100 text-left text-xs text-indigo-900">
            <p className="font-semibold mb-1">Borrowing Criteria (0–100 Scale):</p>
            <ul className="list-disc pl-4 space-y-1">
              <li><strong>Score &ge; 50:</strong> Minimum threshold to apply for a loan.</li>
              <li><strong>Score &lt; 60:</strong> Collateral required for approval.</li>
              <li><strong>Score &ge; 80:</strong> Prime tier (8% APR).</li>
              <li><strong>Score 70–79:</strong> Preferred tier (10% APR).</li>
              <li><strong>Score 60–69:</strong> Standard tier (12% APR).</li>
              <li><strong>Score 50–59:</strong> Base tier (15% APR + collateral).</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
