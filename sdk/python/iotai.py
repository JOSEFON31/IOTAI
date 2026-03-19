"""
IOTAI Python SDK

3-line integration for AI agents:
    client = IOTAI('http://localhost:8080')
    client.create_wallet()
    client.send('iotai_recipient...', 100)
"""

import json
import time
import threading
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import urlencode


class IOTAIError(Exception):
    """Error returned by the IOTAI node."""
    pass


class IOTAI:
    """
    IOTAI SDK Client.

    Args:
        base_url: IOTAI node URL (e.g. 'http://localhost:8080')
        token: Pre-existing auth token
        mnemonic: Restore wallet on init
        timeout: Request timeout in seconds (default 10)
    """

    def __init__(self, base_url, token=None, mnemonic=None, timeout=10):
        self.base_url = base_url.rstrip('/')
        self.token = token
        self.address = None
        self.mnemonic = None
        self.public_key = None
        self.timeout = timeout

        if mnemonic:
            self.restore_wallet(mnemonic)

    # ============================================================
    # WALLET
    # ============================================================

    def create_wallet(self):
        """Create a new wallet and authenticate."""
        res = self._post('/api/v1/wallet/create', {})
        self.address = res['address']
        self.mnemonic = res['mnemonic']
        self.public_key = res.get('publicKey')
        self.authenticate(res['mnemonic'])
        return {'address': res['address'], 'mnemonic': res['mnemonic']}

    def restore_wallet(self, mnemonic):
        """Restore wallet from mnemonic and authenticate."""
        res = self._post('/api/v1/wallet/restore', {'mnemonic': mnemonic})
        self.address = res['address']
        self.mnemonic = mnemonic
        self.public_key = res.get('publicKey')
        self.authenticate(mnemonic)
        return {'address': res['address']}

    def authenticate(self, mnemonic=None):
        """Authenticate with the node."""
        res = self._post('/api/v1/auth/token', {'mnemonic': mnemonic or self.mnemonic})
        self.token = res['token']
        self.address = res['address']
        return res

    # ============================================================
    # TRANSACTIONS
    # ============================================================

    def send(self, to, amount, metadata=None):
        """Send IOTAI tokens."""
        self._ensure_auth()
        body = {'to': to, 'amount': amount}
        if metadata:
            body['metadata'] = metadata
        return self._post('/api/v1/transfer', body)

    def store_data(self, metadata):
        """Store data on the DAG."""
        self._ensure_auth()
        return self._post('/api/v1/data', {'metadata': metadata})

    def get_balance(self):
        """Get current balance."""
        self._ensure_auth()
        res = self._get('/api/v1/balance')
        return res['balance']

    def get_history(self):
        """Get transaction history."""
        self._ensure_auth()
        return self._get('/api/v1/history')

    def get_transaction(self, tx_id):
        """Get transaction details."""
        self._ensure_auth()
        return self._get(f'/api/v1/tx/{tx_id}')

    def calculate_fee(self, amount):
        """Calculate fee for amount."""
        res = self._get(f'/api/v1/fees/calculate?amount={amount}')
        return res['fee']

    # ============================================================
    # MARKETPLACE
    # ============================================================

    def browse_listings(self, **filters):
        """Browse marketplace listings."""
        params = urlencode({k: v for k, v in filters.items() if v is not None})
        url = f'/api/v1/marketplace/listings?{params}' if params else '/api/v1/marketplace/listings'
        return self._get(url)

    def get_listing(self, listing_id):
        """Get listing details."""
        return self._get(f'/api/v1/marketplace/listing/{listing_id}')

    def create_listing(self, title, price, description='', category='general', tags=None, delivery_time='instant'):
        """Create a service listing."""
        self._ensure_auth()
        return self._post('/api/v1/marketplace/list', {
            'title': title, 'description': description, 'price': price,
            'category': category, 'tags': tags or [], 'deliveryTime': delivery_time
        })

    def purchase(self, listing_id, message='', use_escrow=True):
        """Purchase a listing (with escrow by default)."""
        self._ensure_auth()
        return self._post('/api/v1/marketplace/buy', {
            'listingId': listing_id, 'message': message, 'useEscrow': use_escrow
        })

    def confirm_delivery(self, purchase_id):
        """Confirm delivery (release escrow to seller)."""
        self._ensure_auth()
        return self._post('/api/v1/marketplace/escrow/confirm', {'purchaseId': purchase_id})

    def request_refund(self, purchase_id, reason=''):
        """Request refund from escrow."""
        self._ensure_auth()
        return self._post('/api/v1/marketplace/escrow/refund-request', {
            'purchaseId': purchase_id, 'reason': reason
        })

    def review(self, purchase_id, rating, comment=''):
        """Leave a review (1-5 stars)."""
        self._ensure_auth()
        return self._post('/api/v1/marketplace/review', {
            'purchaseId': purchase_id, 'rating': rating, 'comment': comment
        })

    def get_seller_profile(self, address):
        """Get seller profile."""
        return self._get(f'/api/v1/marketplace/seller/{address}')

    def get_my_purchases(self):
        """Get my purchases."""
        self._ensure_auth()
        return self._get('/api/v1/marketplace/my/purchases')

    def get_my_listings(self):
        """Get my listings."""
        self._ensure_auth()
        return self._get('/api/v1/marketplace/my/listings')

    # ============================================================
    # SMART CONTRACTS
    # ============================================================

    def deploy_contract(self, name, conditions, actions, max_executions=None):
        """Deploy a smart contract."""
        self._ensure_auth()
        body = {'name': name, 'conditions': conditions, 'actions': actions}
        if max_executions is not None:
            body['maxExecutions'] = max_executions
        return self._post('/api/v1/contracts/deploy', body)

    def get_contract(self, contract_id):
        """Get contract status."""
        self._ensure_auth()
        return self._get(f'/api/v1/contracts/{contract_id}')

    def get_my_contracts(self):
        """Get my contracts."""
        self._ensure_auth()
        return self._get('/api/v1/contracts/my')

    # ============================================================
    # ORCHESTRATION
    # ============================================================

    def create_pipeline(self, name, tasks, budget):
        """Create a multi-agent task pipeline."""
        self._ensure_auth()
        return self._post('/api/v1/orchestrator/pipeline', {
            'name': name, 'tasks': tasks, 'budget': budget
        })

    def get_pipeline(self, pipeline_id):
        """Get pipeline status."""
        self._ensure_auth()
        return self._get(f'/api/v1/orchestrator/pipeline/{pipeline_id}')

    def register_worker(self, capabilities):
        """Register as a worker agent."""
        self._ensure_auth()
        return self._post('/api/v1/orchestrator/worker/register', {'capabilities': capabilities})

    def claim_task(self, pipeline_id, task_index):
        """Claim a task from the queue."""
        self._ensure_auth()
        return self._post('/api/v1/orchestrator/task/claim', {
            'pipelineId': pipeline_id, 'taskIndex': task_index
        })

    def submit_result(self, pipeline_id, task_index, result):
        """Submit task result."""
        self._ensure_auth()
        return self._post('/api/v1/orchestrator/task/submit', {
            'pipelineId': pipeline_id, 'taskIndex': task_index, 'result': result
        })

    # ============================================================
    # NETWORK
    # ============================================================

    def get_network_stats(self):
        """Get network statistics."""
        return self._get('/api/v1/network/stats')

    def get_node_info(self):
        """Get node info."""
        return self._get('/api/v1/network/node-info')

    def get_address_info(self, address):
        """Get address info."""
        return self._get(f'/api/v1/address/{address}')

    # ============================================================
    # INTERNALS
    # ============================================================

    def _ensure_auth(self):
        if not self.token:
            raise IOTAIError('Not authenticated. Call create_wallet() or restore_wallet() first.')

    def _get(self, path):
        headers = {}
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'

        req = Request(f'{self.base_url}{path}', headers=headers, method='GET')
        try:
            with urlopen(req, timeout=self.timeout) as res:
                return json.loads(res.read().decode())
        except HTTPError as e:
            body = json.loads(e.read().decode())
            raise IOTAIError(body.get('error', f'HTTP {e.code}'))

    def _post(self, path, body):
        headers = {'Content-Type': 'application/json'}
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'

        data = json.dumps(body).encode()
        req = Request(f'{self.base_url}{path}', data=data, headers=headers, method='POST')
        try:
            with urlopen(req, timeout=self.timeout) as res:
                return json.loads(res.read().decode())
        except HTTPError as e:
            body = json.loads(e.read().decode())
            raise IOTAIError(body.get('error', f'HTTP {e.code}'))


# Convenience: allow `python -m iotai` quick test
if __name__ == '__main__':
    import sys
    url = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8080'
    client = IOTAI(url)
    wallet = client.create_wallet()
    print(f'Wallet created: {wallet["address"]}')
    print(f'Mnemonic: {wallet["mnemonic"]}')
    print(f'Balance: {client.get_balance()} IOTAI')
    stats = client.get_network_stats()
    print(f'Network: {stats.get("totalTransactions", "?")} txs, {stats.get("activePeers", "?")} peers')
