#!/usr/bin/env python3
"""
IOTAI Whitepaper PDF Generator
Generates a formal academic-style whitepaper for the IOTAI cryptocurrency project.
"""

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch, mm
from reportlab.lib.colors import HexColor, black, white, gray
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle,
    KeepTogether, HRFlowable, ListFlowable, ListItem, Flowable
)
from reportlab.pdfgen import canvas
from reportlab.platypus.doctemplate import PageTemplate, BaseDocTemplate, Frame
import os
import datetime

# ─── Colors ───
PRIMARY = HexColor('#1a1a2e')
ACCENT = HexColor('#00d4aa')
ACCENT_DARK = HexColor('#00b894')
SECTION_BG = HexColor('#f8f9fa')
TABLE_HEADER = HexColor('#1a1a2e')
TABLE_ALT = HexColor('#f0f4f8')
LIGHT_GRAY = HexColor('#e8e8e8')
DARK_TEXT = HexColor('#2d3436')
MEDIUM_TEXT = HexColor('#636e72')

# ─── Output ───
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs')
os.makedirs(OUTPUT_DIR, exist_ok=True)
OUTPUT_PATH = os.path.join(OUTPUT_DIR, 'IOTAI-Whitepaper.pdf')


class NumberedCanvas(canvas.Canvas):
    """Canvas with page numbers and header/footer."""
    def __init__(self, *args, **kwargs):
        canvas.Canvas.__init__(self, *args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self._draw_page_extras(num_pages)
            canvas.Canvas.showPage(self)
        canvas.Canvas.save(self)

    def _draw_page_extras(self, page_count):
        page_num = self._pageNumber
        if page_num == 1:
            return  # No header/footer on cover
        self.saveState()
        # Footer line
        self.setStrokeColor(LIGHT_GRAY)
        self.setLineWidth(0.5)
        self.line(72, 50, letter[0] - 72, 50)
        # Footer text
        self.setFont('Helvetica', 8)
        self.setFillColor(MEDIUM_TEXT)
        self.drawString(72, 38, "IOTAI Whitepaper v1.0")
        self.drawRightString(letter[0] - 72, 38, f"Page {page_num - 1} of {page_count - 1}")
        self.drawCentredString(letter[0] / 2, 38, "March 2026")
        # Header line
        self.setStrokeColor(LIGHT_GRAY)
        self.line(72, letter[1] - 55, letter[0] - 72, letter[1] - 55)
        self.restoreState()


def get_styles():
    """Create all paragraph styles."""
    styles = getSampleStyleSheet()

    styles.add(ParagraphStyle(
        'CoverTitle',
        parent=styles['Title'],
        fontSize=42,
        leading=50,
        textColor=white,
        alignment=TA_CENTER,
        spaceAfter=10,
        fontName='Helvetica-Bold',
    ))

    styles.add(ParagraphStyle(
        'CoverSubtitle',
        parent=styles['Normal'],
        fontSize=16,
        leading=22,
        textColor=HexColor('#cccccc'),
        alignment=TA_CENTER,
        spaceAfter=6,
    ))

    styles.add(ParagraphStyle(
        'CoverVersion',
        parent=styles['Normal'],
        fontSize=11,
        leading=16,
        textColor=HexColor('#999999'),
        alignment=TA_CENTER,
        spaceAfter=4,
    ))

    styles.add(ParagraphStyle(
        'AbstractTitle',
        parent=styles['Heading1'],
        fontSize=14,
        leading=18,
        textColor=PRIMARY,
        alignment=TA_CENTER,
        spaceBefore=20,
        spaceAfter=10,
        fontName='Helvetica-Bold',
    ))

    styles.add(ParagraphStyle(
        'AbstractBody',
        parent=styles['Normal'],
        fontSize=10,
        leading=15,
        textColor=DARK_TEXT,
        alignment=TA_JUSTIFY,
        leftIndent=36,
        rightIndent=36,
        spaceBefore=4,
        spaceAfter=4,
    ))

    styles.add(ParagraphStyle(
        'SectionTitle',
        parent=styles['Heading1'],
        fontSize=18,
        leading=24,
        textColor=PRIMARY,
        spaceBefore=24,
        spaceAfter=12,
        fontName='Helvetica-Bold',
        borderWidth=0,
        borderPadding=0,
    ))

    styles.add(ParagraphStyle(
        'SubsectionTitle',
        parent=styles['Heading2'],
        fontSize=13,
        leading=18,
        textColor=ACCENT_DARK,
        spaceBefore=16,
        spaceAfter=8,
        fontName='Helvetica-Bold',
    ))

    styles.add(ParagraphStyle(
        'SubsubTitle',
        parent=styles['Heading3'],
        fontSize=11,
        leading=15,
        textColor=DARK_TEXT,
        spaceBefore=10,
        spaceAfter=6,
        fontName='Helvetica-Bold',
    ))

    styles.add(ParagraphStyle(
        'BodyText2',
        parent=styles['Normal'],
        fontSize=10,
        leading=15,
        textColor=DARK_TEXT,
        alignment=TA_JUSTIFY,
        spaceBefore=3,
        spaceAfter=6,
    ))

    styles.add(ParagraphStyle(
        'CodeBlock',
        parent=styles['Normal'],
        fontSize=8,
        leading=11,
        fontName='Courier',
        textColor=HexColor('#2d3436'),
        backColor=HexColor('#f4f4f4'),
        leftIndent=20,
        rightIndent=20,
        spaceBefore=6,
        spaceAfter=6,
        borderWidth=0.5,
        borderColor=LIGHT_GRAY,
        borderPadding=8,
    ))

    styles.add(ParagraphStyle(
        'BulletText',
        parent=styles['Normal'],
        fontSize=10,
        leading=14,
        textColor=DARK_TEXT,
        leftIndent=24,
        bulletIndent=12,
        spaceBefore=2,
        spaceAfter=2,
    ))

    styles.add(ParagraphStyle(
        'TableHeader',
        parent=styles['Normal'],
        fontSize=9,
        leading=12,
        textColor=white,
        fontName='Helvetica-Bold',
        alignment=TA_CENTER,
    ))

    styles.add(ParagraphStyle(
        'TableCell',
        parent=styles['Normal'],
        fontSize=9,
        leading=12,
        textColor=DARK_TEXT,
        alignment=TA_LEFT,
    ))

    styles.add(ParagraphStyle(
        'TableCellCenter',
        parent=styles['Normal'],
        fontSize=9,
        leading=12,
        textColor=DARK_TEXT,
        alignment=TA_CENTER,
    ))

    styles.add(ParagraphStyle(
        'FootnoteText',
        parent=styles['Normal'],
        fontSize=8,
        leading=11,
        textColor=MEDIUM_TEXT,
        spaceBefore=2,
        spaceAfter=2,
    ))

    styles.add(ParagraphStyle(
        'TOCEntry',
        parent=styles['Normal'],
        fontSize=11,
        leading=18,
        textColor=DARK_TEXT,
        leftIndent=0,
    ))

    styles.add(ParagraphStyle(
        'TOCSubEntry',
        parent=styles['Normal'],
        fontSize=10,
        leading=16,
        textColor=MEDIUM_TEXT,
        leftIndent=20,
    ))

    return styles


def draw_cover_page(canvas_obj, doc):
    """Draw cover page background directly on canvas."""
    c = canvas_obj
    w, h = letter

    # Background
    c.setFillColor(PRIMARY)
    c.rect(0, 0, w, h, fill=1, stroke=0)

    # Top accent bar
    c.setFillColor(ACCENT)
    c.rect(0, h - 8, w, 8, fill=1, stroke=0)

    # DAG-like network visualization (abstract)
    import random
    random.seed(42)
    nodes = []
    for i in range(25):
        x = random.uniform(40, w - 40)
        y = random.uniform(h * 0.55, h - 40)
        nodes.append((x, y))
        c.setFillColor(HexColor('#00d4aa'))
        c.setFillAlpha(0.2)
        c.circle(x, y, 3, fill=1, stroke=0)

    c.setStrokeColor(HexColor('#00d4aa'))
    c.setStrokeAlpha(0.1)
    c.setLineWidth(0.3)
    for i, (x1, y1) in enumerate(nodes):
        for j, (x2, y2) in enumerate(nodes):
            if i < j and abs(x1 - x2) < 120 and abs(y1 - y2) < 80:
                c.line(x1, y1, x2, y2)

    # Bottom DAG nodes
    nodes2 = []
    for i in range(20):
        x = random.uniform(40, w - 40)
        y = random.uniform(20, h * 0.2)
        nodes2.append((x, y))
        c.setFillColor(HexColor('#00d4aa'))
        c.setFillAlpha(0.15)
        c.circle(x, y, 2.5, fill=1, stroke=0)

    c.setStrokeColor(HexColor('#00d4aa'))
    c.setStrokeAlpha(0.08)
    for i, (x1, y1) in enumerate(nodes2):
        for j, (x2, y2) in enumerate(nodes2):
            if i < j and abs(x1 - x2) < 100 and abs(y1 - y2) < 60:
                c.line(x1, y1, x2, y2)

    # Reset alpha
    c.setFillAlpha(1.0)
    c.setStrokeAlpha(1.0)


def build_cover(styles):
    """Build cover page elements."""
    elements = []

    elements.append(Spacer(1, 200))

    # Title
    elements.append(Paragraph("IOTAI", styles['CoverTitle']))
    elements.append(Spacer(1, 8))
    elements.append(Paragraph(
        "A DAG-Based Cryptocurrency for<br/>Autonomous AI Agent Payments",
        styles['CoverSubtitle']
    ))
    elements.append(Spacer(1, 30))

    # Accent line
    elements.append(HRFlowable(
        width="40%", thickness=2, color=ACCENT,
        spaceAfter=20, spaceBefore=0, hAlign='CENTER'
    ))

    # Version info
    elements.append(Paragraph("Whitepaper v1.0", styles['CoverVersion']))
    elements.append(Paragraph("March 2026", styles['CoverVersion']))
    elements.append(Spacer(1, 20))
    elements.append(Paragraph(
        "Jose Fonseca<br/>IOTAI Project",
        styles['CoverVersion']
    ))

    elements.append(PageBreak())
    return elements


def build_toc(styles):
    """Build table of contents."""
    elements = []
    elements.append(Paragraph("Table of Contents", styles['SectionTitle']))
    elements.append(HRFlowable(width="100%", thickness=1, color=ACCENT, spaceAfter=16))

    toc_items = [
        ("1.", "Introduction", [
            ("1.1", "The AI Agent Economy"),
            ("1.2", "Limitations of Existing Solutions"),
            ("1.3", "IOTAI Vision"),
        ]),
        ("2.", "Architecture Overview", [
            ("2.1", "System Components"),
            ("2.2", "Transaction Lifecycle"),
        ]),
        ("3.", "DAG (Tangle) Structure", [
            ("3.1", "Graph Topology"),
            ("3.2", "Tip Selection Algorithm"),
            ("3.3", "Cumulative Weight Propagation"),
        ]),
        ("4.", "Consensus Mechanism", [
            ("4.1", "Confirmation by Convergence"),
            ("4.2", "Validation Rules"),
            ("4.3", "Double-Spend Prevention"),
            ("4.4", "Conflict Resolution"),
        ]),
        ("5.", "Cryptographic Foundations", [
            ("5.1", "Key Generation and Derivation"),
            ("5.2", "Address Format"),
            ("5.3", "Transaction Signing"),
            ("5.4", "Replay Protection"),
        ]),
        ("6.", "Peer-to-Peer Network", [
            ("6.1", "Network Stack"),
            ("6.2", "Peer Discovery"),
            ("6.3", "DAG Synchronization"),
            ("6.4", "Transaction Propagation"),
        ]),
        ("7.", "Token Economics", [
            ("7.1", "Supply Distribution"),
            ("7.2", "Proof-of-Personhood Faucet"),
            ("7.3", "Sybil Resistance"),
        ]),
        ("8.", "Agent API and Real-Time Events", [
            ("8.1", "RESTful Interface"),
            ("8.2", "Server-Sent Events"),
            ("8.3", "Authentication"),
        ]),
        ("9.", "Wallet System", [
            ("9.1", "HD Wallet Architecture"),
            ("9.2", "BIP39 Seed Phrases"),
            ("9.3", "CLI Interface"),
        ]),
        ("10.", "Data Layer", [
            ("10.1", "On-Chain Data Storage"),
            ("10.2", "Query Interface"),
            ("10.3", "Agent Communication Patterns"),
        ]),
        ("11.", "Security Analysis", [
            ("11.1", "Threat Model"),
            ("11.2", "Cryptographic Guarantees"),
            ("11.3", "Network Security"),
        ]),
        ("12.", "Persistence and Fault Tolerance", [
            ("12.1", "Dual-Layer Storage"),
            ("12.2", "State Recovery"),
        ]),
        ("13.", "Future Work", []),
        ("14.", "Conclusion", []),
    ]

    for num, title, subs in toc_items:
        elements.append(Paragraph(
            f"<b>{num}</b>&nbsp;&nbsp;{title}",
            styles['TOCEntry']
        ))
        for snum, stitle in subs:
            elements.append(Paragraph(
                f"{snum}&nbsp;&nbsp;{stitle}",
                styles['TOCSubEntry']
            ))

    elements.append(PageBreak())
    return elements


def make_table(headers, rows, col_widths=None):
    """Create a styled table."""
    styles = get_styles()
    data = [[Paragraph(f"<b>{h}</b>", styles['TableHeader']) for h in headers]]
    for row in rows:
        data.append([Paragraph(str(c), styles['TableCell']) for c in row])

    if col_widths is None:
        col_widths = [None] * len(headers)

    t = Table(data, colWidths=col_widths, repeatRows=1)
    style_cmds = [
        ('BACKGROUND', (0, 0), (-1, 0), TABLE_HEADER),
        ('TEXTCOLOR', (0, 0), (-1, 0), white),
        ('ALIGN', (0, 0), (-1, 0), 'CENTER'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 9),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 8),
        ('TOPPADDING', (0, 0), (-1, 0), 8),
        ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 1), (-1, -1), 9),
        ('TOPPADDING', (0, 1), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 1), (-1, -1), 6),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('GRID', (0, 0), (-1, -1), 0.5, LIGHT_GRAY),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [white, TABLE_ALT]),
    ]
    t.setStyle(TableStyle(style_cmds))
    return t


def section(title, styles):
    return [
        Paragraph(title, styles['SectionTitle']),
        HRFlowable(width="100%", thickness=1, color=ACCENT, spaceAfter=10),
    ]


def subsection(title, styles):
    return [Paragraph(title, styles['SubsectionTitle'])]


def body(text, styles):
    return [Paragraph(text, styles['BodyText2'])]


def code(text, styles):
    return [Paragraph(text.replace('\n', '<br/>').replace(' ', '&nbsp;'), styles['CodeBlock'])]


def bullet_list(items, styles):
    return [Paragraph(f"<bullet>&bull;</bullet> {item}", styles['BulletText']) for item in items]


def build_content(styles):
    """Build the main whitepaper content."""
    elements = []

    # ═══════════════════════════════════════════════
    # ABSTRACT
    # ═══════════════════════════════════════════════
    elements.append(Paragraph("Abstract", styles['AbstractTitle']))
    elements.append(HRFlowable(width="30%", thickness=0.5, color=ACCENT, spaceAfter=10, hAlign='CENTER'))
    elements += body(
        "We present IOTAI, a Directed Acyclic Graph (DAG)-based cryptocurrency specifically designed "
        "for autonomous AI agent payments. Unlike traditional blockchain architectures that rely on "
        "sequential block production and energy-intensive mining, IOTAI employs a tangle structure "
        "where each transaction validates two previous transactions, enabling feeless, near-instant "
        "settlements. The system features a novel Proof-of-Personhood faucet mechanism that uses "
        "facial biometric verification with privacy-preserving embeddings to ensure fair token "
        "distribution while resisting Sybil attacks. IOTAI provides a comprehensive RESTful API "
        "with Server-Sent Events (SSE) for real-time notifications, enabling AI agents to "
        "programmatically create wallets, transfer tokens, store data on-chain, and subscribe "
        "to network events without human intervention. The architecture supports hierarchical "
        "deterministic (HD) wallets with BIP39 seed phrases, dual-layer persistence with automatic "
        "failover, and a peer-to-peer network built on libp2p with Kademlia DHT discovery. "
        "This paper describes the complete technical specification of the IOTAI protocol, its "
        "consensus mechanism, cryptographic foundations, and economic model.",
        styles
    )
    elements.append(Spacer(1, 10))
    elements += body(
        "<b>Keywords:</b> DAG, tangle, cryptocurrency, AI agents, machine payments, "
        "proof-of-personhood, feeless transactions, peer-to-peer, Ed25519, BLAKE3.",
        styles
    )
    elements.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 1. INTRODUCTION
    # ═══════════════════════════════════════════════
    elements += section("1. Introduction", styles)

    elements += subsection("1.1 The AI Agent Economy", styles)
    elements += body(
        "The rapid advancement of large language models (LLMs) and autonomous AI systems has "
        "created an emerging economy where AI agents operate independently, performing tasks "
        "ranging from data analysis to service orchestration. These agents increasingly require "
        "the ability to transact value autonomously: purchasing compute resources, paying for "
        "API access, compensating data providers, and settling inter-agent service agreements. "
        "Current payment infrastructure, designed for human-initiated transactions with manual "
        "authorization, presents fundamental barriers to machine-to-machine commerce.",
        styles
    )

    elements += subsection("1.2 Limitations of Existing Solutions", styles)
    elements += body(
        "Traditional blockchain-based cryptocurrencies suffer from several limitations when "
        "applied to AI agent payments:",
        styles
    )
    elements += bullet_list([
        "<b>Transaction fees:</b> Even small fees become prohibitive at the volume and granularity "
        "required by autonomous agents performing thousands of micro-transactions per hour.",
        "<b>Confirmation latency:</b> Block-based systems require multiple confirmations (minutes "
        "to hours), incompatible with real-time agent coordination.",
        "<b>Sequential processing:</b> Blockchain's linear block structure creates bottlenecks "
        "as transaction volume increases.",
        "<b>API complexity:</b> Most cryptocurrency nodes expose low-level RPC interfaces not "
        "designed for programmatic agent consumption.",
        "<b>Identity and distribution:</b> Existing token distribution mechanisms (ICOs, airdrops, "
        "mining) either centralize control or waste energy, without ensuring fair human-verified distribution.",
    ], styles)

    elements += subsection("1.3 IOTAI Vision", styles)
    elements += body(
        "IOTAI addresses these challenges through a purpose-built DAG architecture that eliminates "
        "transaction fees, provides near-instant confirmation, and scales horizontally with network "
        "growth. The protocol is designed API-first, with RESTful endpoints and real-time event "
        "streaming that enable AI agents to participate in the network as first-class citizens. "
        "A Proof-of-Personhood faucet ensures equitable initial token distribution by verifying "
        "unique human identity through privacy-preserving facial biometrics, preventing Sybil "
        "attacks while maintaining user anonymity.",
        styles
    )

    elements.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 2. ARCHITECTURE OVERVIEW
    # ═══════════════════════════════════════════════
    elements += section("2. Architecture Overview", styles)

    elements += subsection("2.1 System Components", styles)
    elements += body(
        "The IOTAI system consists of six primary components that operate in concert to provide "
        "a complete decentralized payment infrastructure for AI agents:",
        styles
    )

    elements.append(make_table(
        ["Component", "Function", "Implementation"],
        [
            ["DAG Ledger", "Transaction storage and ordering", "In-memory tangle with BLAKE3 hashing"],
            ["Consensus Validator", "Transaction validation and confirmation", "Cumulative weight convergence"],
            ["P2P Network", "Peer discovery and data propagation", "libp2p with TCP, NOISE, Yamux"],
            ["Agent API", "Programmatic access for AI agents", "REST + SSE on Express.js"],
            ["Wallet System", "Key management and transaction signing", "HD wallet with Ed25519"],
            ["Persistence Layer", "State durability and recovery", "Dual-layer: disk + GitHub API"],
        ],
        [90, 150, 200]
    ))

    elements += subsection("2.2 Transaction Lifecycle", styles)
    elements += body(
        "A transaction in IOTAI follows a deterministic lifecycle from creation to confirmation:",
        styles
    )
    elements += body(
        "<b>1. Creation:</b> An AI agent constructs a transaction specifying recipient, amount, "
        "and optional metadata. The agent's wallet selects two tip transactions from the DAG "
        "as parents, generates a unique nonce, and computes the BLAKE3 hash of the canonical "
        "transaction fields.",
        styles
    )
    elements += body(
        "<b>2. Signing:</b> The transaction hash is signed using the agent's Ed25519 private key, "
        "producing a 64-byte detached signature that is appended to the transaction.",
        styles
    )
    elements += body(
        "<b>3. Validation:</b> The local node validates the transaction against consensus rules: "
        "parent existence, timestamp bounds, balance sufficiency, nonce uniqueness, and "
        "double-spend detection.",
        styles
    )
    elements += body(
        "<b>4. Propagation:</b> Upon local validation, the transaction is broadcast to all "
        "connected peers via the /iotai/tx/1.0.0 protocol stream.",
        styles
    )
    elements += body(
        "<b>5. Confirmation:</b> As subsequent transactions reference this transaction (directly "
        "or indirectly), its cumulative weight increases. Once the weight reaches the confirmation "
        "threshold (default: 5), the transaction is considered confirmed.",
        styles
    )

    elements.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 3. DAG (TANGLE) STRUCTURE
    # ═══════════════════════════════════════════════
    elements += section("3. DAG (Tangle) Structure", styles)

    elements += subsection("3.1 Graph Topology", styles)
    elements += body(
        "IOTAI's ledger is a Directed Acyclic Graph (DAG) where vertices represent transactions "
        "and directed edges represent validation relationships. Each transaction must reference "
        "exactly two parent transactions (tips), creating a mesh structure that grows wider "
        "rather than longer as network activity increases. This topology provides several "
        "advantages over linear blockchain structures:",
        styles
    )
    elements += bullet_list([
        "<b>Parallel processing:</b> Multiple transactions can be added simultaneously without "
        "contention, as they simply reference different tips.",
        "<b>Natural scalability:</b> Higher transaction throughput increases the rate of "
        "confirmation rather than creating backlogs.",
        "<b>No miners or validators:</b> Each transaction participates in consensus by "
        "validating its parents, eliminating the need for dedicated block producers.",
    ], styles)
    elements += body(
        "The DAG maintains four core data structures: a transaction map (Map&lt;txId, Transaction&gt;), "
        "a tips set (Set&lt;txId&gt;) tracking the frontier, a children map "
        "(Map&lt;parentId, Set&lt;childIds&gt;&gt;) for traversal, and a balance map "
        "(Map&lt;address, amount&gt;) for O(1) balance lookups.",
        styles
    )

    elements += subsection("3.2 Tip Selection Algorithm", styles)
    elements += body(
        "Tip selection is critical to DAG health, as it determines which transactions receive "
        "validation and how quickly the network converges. IOTAI implements a weighted random "
        "walk algorithm with diversity enhancement:",
        styles
    )
    elements += body(
        "Let T = {t<sub>1</sub>, t<sub>2</sub>, ..., t<sub>n</sub>} be the set of current tips, "
        "and W(t<sub>i</sub>) the cumulative weight of tip t<sub>i</sub>. The probability of "
        "selecting tip t<sub>i</sub> is proportional to W(t<sub>i</sub>):",
        styles
    )
    elements += body(
        "<i>P(t<sub>i</sub>) = W(t<sub>i</sub>) / SUM(W(t<sub>j</sub>)) for all j in T</i>",
        styles
    )
    elements += body(
        "To prevent both tips from being identical (which would reduce DAG width), the algorithm "
        "attempts up to five selections to ensure diversity. If after five attempts the same tip "
        "is selected, it is accepted to avoid infinite loops. Edge cases are handled gracefully: "
        "if zero tips exist, the genesis transaction is used twice; if one tip exists, it is used "
        "for both parents.",
        styles
    )

    elements += subsection("3.3 Cumulative Weight Propagation", styles)
    elements += body(
        "Each transaction is assigned an initial weight of 1. When transaction T<sub>new</sub> "
        "references parents P<sub>1</sub> and P<sub>2</sub>, the cumulative weights of P<sub>1</sub>, "
        "P<sub>2</sub>, and all their ancestors are incremented by 1. This propagation follows "
        "a backward traversal using BFS through the DAG:",
        styles
    )
    elements += code(
        "function updateCumulativeWeights(newTx):\n"
        "  visited = Set()\n"
        "  queue = [newTx.parent1, newTx.parent2]\n"
        "  while queue is not empty:\n"
        "    current = queue.dequeue()\n"
        "    if current in visited: continue\n"
        "    visited.add(current)\n"
        "    current.cumulativeWeight += 1\n"
        "    queue.enqueue(current.parents)",
        styles
    )
    elements += body(
        "The cumulative weight of a transaction represents the total number of transactions "
        "that have directly or indirectly validated it. Higher weight indicates stronger consensus "
        "and greater confidence in the transaction's finality.",
        styles
    )

    elements.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 4. CONSENSUS MECHANISM
    # ═══════════════════════════════════════════════
    elements += section("4. Consensus Mechanism", styles)

    elements += subsection("4.1 Confirmation by Convergence", styles)
    elements += body(
        "IOTAI achieves consensus without mining, staking, or elected leaders. Instead, consensus "
        "emerges naturally from the DAG structure: as more transactions are added to the network, "
        "they validate older transactions by referencing them as parents. A transaction is "
        "considered confirmed when its cumulative weight reaches a configurable threshold "
        "(default: 5).",
        styles
    )
    elements += body(
        "The confirmation confidence of a transaction with cumulative weight W and threshold "
        "T is defined as:",
        styles
    )
    elements += body(
        "<i>confidence(W) = min(1.0, W / T)</i>",
        styles
    )
    elements += body(
        "This provides a continuous confidence metric rather than a binary confirmed/unconfirmed "
        "state, allowing agents to make risk-adjusted decisions based on transaction maturity.",
        styles
    )

    elements += subsection("4.2 Validation Rules", styles)
    elements += body(
        "Before a transaction is accepted into the DAG, it must pass a sequential validation "
        "pipeline consisting of eight checks:",
        styles
    )

    elements.append(make_table(
        ["#", "Check", "Criteria", "Rationale"],
        [
            ["1", "Network minimum", "At least 1 connected peer", "Prevents isolated branches"],
            ["2", "Parent existence", "Both parents exist in DAG", "Structural integrity"],
            ["3", "Timestamp bounds", "Within +/- 5 min of current time", "Prevents future-dating"],
            ["4", "Parent freshness", "Warning if parent > 24h old", "Encourages tip diversity"],
            ["5", "Signature validity", "Ed25519 verification passes", "Authentication"],
            ["6", "Balance sufficiency", "Sender balance >= amount", "Prevents overdraft"],
            ["7", "Nonce uniqueness", "Nonce not previously used", "Replay protection"],
            ["8", "Double-spend check", "Pending outflows within balance", "Prevents double-spend"],
        ],
        [20, 90, 130, 200]
    ))

    elements += subsection("4.3 Double-Spend Prevention", styles)
    elements += body(
        "Double-spend detection operates on unconfirmed transactions. For each pending transfer "
        "from a given sender address, the validator computes the total unconfirmed outflow and "
        "verifies that the sum of all pending outflows plus the new transaction amount does not "
        "exceed the sender's current balance:",
        styles
    )
    elements += body(
        "<i>SUM(unconfirmed_outflows(sender)) + new_amount &lt;= balance(sender)</i>",
        styles
    )
    elements += body(
        "This approach allows multiple concurrent transactions from the same address while "
        "preventing over-spending, which is essential for AI agents that may issue rapid "
        "sequential payments.",
        styles
    )

    elements += subsection("4.4 Conflict Resolution", styles)
    elements += body(
        "When two conflicting transactions exist in the DAG (e.g., double-spend attempts that "
        "entered through different nodes), IOTAI resolves conflicts using a deterministic "
        "three-tier priority system:",
        styles
    )
    elements += bullet_list([
        "<b>Primary:</b> Higher cumulative weight wins (more network validation).",
        "<b>Secondary:</b> Earlier timestamp wins (temporal precedence).",
        "<b>Tertiary:</b> Lexicographic hash comparison (deterministic tiebreaker).",
    ], styles)
    elements += body(
        "This resolution mechanism ensures that all honest nodes converge on the same transaction "
        "ordering without requiring explicit coordination or voting rounds.",
        styles
    )

    elements.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 5. CRYPTOGRAPHIC FOUNDATIONS
    # ═══════════════════════════════════════════════
    elements += section("5. Cryptographic Foundations", styles)

    elements += subsection("5.1 Key Generation and Derivation", styles)
    elements += body(
        "IOTAI employs a modern cryptographic stack optimized for performance and security:",
        styles
    )

    elements.append(make_table(
        ["Component", "Algorithm", "Library", "Output Size"],
        [
            ["Digital Signatures", "Ed25519", "TweetNaCl", "64-byte signature"],
            ["Hashing", "BLAKE3", "blake3", "256-bit digest"],
            ["Key Derivation", "BLAKE3-keyed", "blake3", "256-bit child seed"],
            ["Encoding", "Base64 / Hex", "uint8arrays", "Variable"],
        ],
        [100, 90, 80, 100]
    ))
    elements.append(Spacer(1, 8))

    elements += body(
        "Hierarchical Deterministic (HD) key derivation follows a custom scheme using BLAKE3's "
        "keyed hashing mode. Given a 256-bit master seed S and derivation index i, the child "
        "keypair is computed as:",
        styles
    )
    elements += body(
        "<i>child_seed = BLAKE3_keyed(S, encode(i))</i><br/>"
        "<i>child_keypair = Ed25519_from_seed(child_seed)</i>",
        styles
    )
    elements += body(
        "This provides deterministic, one-way derivation: the same seed and index always produce "
        "the same keypair, but the master seed cannot be recovered from child keys.",
        styles
    )

    elements += subsection("5.2 Address Format", styles)
    elements += body(
        "IOTAI addresses are derived from public keys using a one-way hash function to provide "
        "an additional layer of security (quantum resistance of the address, as opposed to the "
        "public key):",
        styles
    )
    elements += code(
        'address = "iotai_" + BLAKE3(publicKey)[0:40 hex chars]\n'
        'Example: iotai_3a4f5b2c8d9e1f6a7b8c9d0e1f2a3b4c5d6e7f8a',
        styles
    )
    elements += body(
        "The 6-character prefix provides human-readable identification, while the 40-character "
        "hex hash (160 bits) provides collision resistance of 2<super>80</super> under the birthday bound.",
        styles
    )

    elements += subsection("5.3 Transaction Signing", styles)
    elements += body(
        "Transaction integrity is ensured through a canonical hashing and signing process. "
        "The hashable fields are serialized with sorted keys to ensure deterministic output "
        "regardless of field insertion order:",
        styles
    )
    elements += code(
        "hashable = {\n"
        "  type, from, to, amount, timestamp,\n"
        "  nonce, parents: sorted([p1, p2]),\n"
        "  metadata?: object\n"
        "}\n"
        "txHash = BLAKE3(JSON.stringify(hashable, sortedKeys))\n"
        "signature = Ed25519.sign_detached(txHash, secretKey)",
        styles
    )

    elements += subsection("5.4 Replay Protection", styles)
    elements += body(
        "Each transaction includes a unique nonce composed of a millisecond timestamp and "
        "8 bytes of cryptographic randomness. The DAG maintains a set of all used nonces; "
        "any transaction with a previously-seen nonce is rejected. Nonces are persisted across "
        "node restarts through both explicit serialization and reconstruction from the "
        "transaction history, providing belt-and-suspenders protection against replay attacks.",
        styles
    )

    elements.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 6. PEER-TO-PEER NETWORK
    # ═══════════════════════════════════════════════
    elements += section("6. Peer-to-Peer Network", styles)

    elements += subsection("6.1 Network Stack", styles)
    elements += body(
        "IOTAI's networking layer is built on libp2p, a modular peer-to-peer framework that "
        "provides transport, encryption, and discovery primitives:",
        styles
    )
    elements += bullet_list([
        "<b>Transport:</b> TCP/IP with configurable port binding.",
        "<b>Encryption:</b> NOISE protocol with ChaCha20-Poly1305 (authenticated encryption).",
        "<b>Multiplexing:</b> Yamux stream multiplexer for concurrent protocol streams.",
        "<b>Identity:</b> Ed25519 peer identity (separate from wallet keys).",
    ], styles)

    elements += subsection("6.2 Peer Discovery", styles)
    elements += body(
        "Three complementary discovery mechanisms ensure robust peer finding across network "
        "topologies:",
        styles
    )
    elements += body(
        "<b>mDNS (Local Network):</b> Zero-configuration discovery using multicast DNS with a "
        "10-second interval and the service tag 'iotai-network'. Enables automatic peer finding "
        "on local area networks without any configuration.",
        styles
    )
    elements += body(
        "<b>Bootstrap Nodes:</b> Pre-configured peer addresses provided via command-line arguments. "
        "New nodes connect to bootstrap peers to join the wider network.",
        styles
    )
    elements += body(
        "<b>Kademlia DHT:</b> Distributed hash table in server mode enables decentralized peer "
        "discovery without relying on centralized infrastructure. Nodes maintain routing tables "
        "and respond to peer queries.",
        styles
    )

    elements += subsection("6.3 DAG Synchronization", styles)
    elements += body(
        "When a new peer connects, the nodes perform a DAG synchronization using one of two "
        "strategies based on local state:",
        styles
    )
    elements += body(
        "<b>Full Sync:</b> When the local DAG is empty, the node requests all transactions from "
        "the peer, sorted by timestamp. The response includes the complete transaction history, "
        "balance state, and faucet data.",
        styles
    )
    elements += body(
        "<b>Differential Sync:</b> When the local DAG already contains transactions, the node "
        "sends its known transaction IDs. The peer responds with only the missing transactions, "
        "minimizing bandwidth usage. Transactions are imported in timestamp order to maintain "
        "causal consistency.",
        styles
    )
    elements += body(
        "A concurrency lock (syncing flag) prevents multiple simultaneous syncs to the same "
        "peer, avoiding state corruption from interleaved updates.",
        styles
    )

    elements += subsection("6.4 Transaction Propagation", styles)
    elements += body(
        "New transactions are broadcast to all connected peers using a dedicated protocol stream "
        "(/iotai/tx/1.0.0). Each peer receives the serialized transaction, validates it locally, "
        "and if valid, broadcasts it to its own peers. This gossip-style propagation ensures "
        "network-wide dissemination within O(log N) hops for a network of N nodes.",
        styles
    )

    elements.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 7. TOKEN ECONOMICS
    # ═══════════════════════════════════════════════
    elements += section("7. Token Economics", styles)

    elements += subsection("7.1 Supply Distribution", styles)
    elements += body(
        "IOTAI has a fixed total supply of 1,000,000,000 (one billion) tokens, created entirely "
        "at genesis. There is no inflation, no mining rewards, and no token burning. The initial "
        "distribution is designed to maximize equitable access:",
        styles
    )

    elements.append(make_table(
        ["Allocation", "Amount", "Percentage", "Purpose"],
        [
            ["Proof-of-Personhood Faucet", "600,000,000", "60%", "Fair distribution to verified humans"],
            ["Network Reserve", "400,000,000", "40%", "Development, partnerships, ecosystem"],
        ],
        [130, 90, 70, 160]
    ))
    elements.append(Spacer(1, 8))

    elements += body(
        "The faucet distributes 1,000 IOTAI per verified individual, supporting up to 600,000 "
        "recipients before exhaustion. This model ensures broad distribution while preventing "
        "concentration by large holders.",
        styles
    )

    elements += subsection("7.2 Proof-of-Personhood Faucet", styles)
    elements += body(
        "The faucet implements a two-phase verification protocol that combines liveness detection "
        "with biometric uniqueness verification:",
        styles
    )
    elements += body(
        "<b>Phase 1 - Liveness Challenge:</b> The system issues a random physical action "
        "(blink, smile, turn left, turn right, or nod) that must be performed within 120 seconds. "
        "This prevents automated claims using static images or pre-recorded video.",
        styles
    )
    elements += body(
        "<b>Phase 2 - Biometric Verification:</b> A 128-dimensional facial embedding is "
        "extracted client-side using face-api.js (based on FaceNet architecture). The raw "
        "photograph is immediately discarded and never transmitted to the server. The embedding "
        "undergoes quality validation (dimensionality >= 64, variance > 0.001, values within "
        "[-2, 2]) before being checked against stored embeddings using cosine similarity.",
        styles
    )

    elements += subsection("7.3 Sybil Resistance", styles)
    elements += body(
        "The faucet implements multiple layers of Sybil resistance to prevent a single entity "
        "from claiming tokens multiple times:",
        styles
    )

    elements.append(make_table(
        ["Layer", "Mechanism", "Threshold"],
        [
            ["Biometric uniqueness", "Cosine similarity of facial embeddings", "< 0.6 similarity"],
            ["Exact duplicate detection", "BLAKE3 hash of embedding vector", "No hash collision"],
            ["Address binding", "One claim per wallet address", "Address in claimed set"],
            ["IP rate limiting", "Maximum 1 claim per IP address (lifetime)", "1 claim total"],
            ["IP cooldown", "24-hour minimum between attempts", "24h cooldown"],
            ["Liveness verification", "Random physical action challenge", "120s expiry"],
        ],
        [100, 200, 140]
    ))
    elements.append(Spacer(1, 8))

    elements += body(
        "<b>Privacy guarantees:</b> The system stores only the BLAKE3 hash of the facial "
        "embedding (irreversible) and the embedding vector itself (not reconstructible to a "
        "photograph). No facial images are stored or transmitted. The embedding space is "
        "high-dimensional enough to verify uniqueness but insufficient for facial recognition "
        "against external databases.",
        styles
    )

    elements.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 8. AGENT API AND REAL-TIME EVENTS
    # ═══════════════════════════════════════════════
    elements += section("8. Agent API and Real-Time Events", styles)

    elements += subsection("8.1 RESTful Interface", styles)
    elements += body(
        "IOTAI exposes a comprehensive REST API at /api/v1/ designed for programmatic consumption "
        "by AI agents. The API follows standard HTTP semantics with JSON request/response bodies:",
        styles
    )

    elements.append(make_table(
        ["Endpoint", "Method", "Auth", "Description"],
        [
            ["/wallet/create", "POST", "No", "Generate new HD wallet with optional passphrase"],
            ["/auth/token", "POST", "No", "Authenticate and receive bearer token"],
            ["/transfer", "POST", "Yes", "Transfer IOTAI tokens to recipient"],
            ["/data", "POST", "Yes", "Store arbitrary metadata on DAG"],
            ["/balance", "GET", "Yes", "Query wallet balance"],
            ["/history", "GET", "Yes", "Transaction history for wallet"],
            ["/tx/:id", "GET", "No", "Transaction details and confirmation status"],
            ["/data/search", "GET", "No", "Full-text search across data transactions"],
            ["/data/:id", "GET", "No", "Retrieve specific data transaction"],
            ["/network/stats", "GET", "No", "Network statistics and health"],
            ["/network/peers", "GET", "No", "Connected peer information"],
            ["/faucet/status", "GET", "No", "Faucet distribution statistics"],
            ["/faucet/start", "POST", "No", "Initiate liveness challenge"],
            ["/faucet/claim", "POST", "No", "Submit verification and claim tokens"],
            ["/events", "GET", "No", "Server-Sent Events stream"],
        ],
        [90, 45, 30, 275]
    ))

    elements += subsection("8.2 Server-Sent Events (SSE)", styles)
    elements += body(
        "The /api/v1/events endpoint provides a persistent SSE connection for real-time "
        "notifications. AI agents can subscribe to network events without polling:",
        styles
    )

    elements.append(make_table(
        ["Event Type", "Trigger", "Payload"],
        [
            ["transaction", "New transaction added to DAG", "id, type, from, to, amount, metadata"],
            ["sync", "DAG synchronization completed", "peerId, imported count, total transactions"],
            ["peer:connect", "New peer connected", "peerId, total peer count"],
            ["peer:disconnect", "Peer disconnected", "peerId, total peer count"],
        ],
        [90, 150, 200]
    ))
    elements.append(Spacer(1, 8))

    elements += body(
        "A heartbeat comment is sent every 30 seconds to maintain connection liveness across "
        "proxies and load balancers.",
        styles
    )

    elements += subsection("8.3 Authentication", styles)
    elements += body(
        "Protected endpoints require a Bearer token obtained through wallet creation or "
        "authentication. Tokens have a 1-hour TTL and are stored server-side in a Map with "
        "automatic expiration. This stateless-from-client design allows AI agents to authenticate "
        "once and perform multiple operations within the token lifetime.",
        styles
    )

    elements.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 9. WALLET SYSTEM
    # ═══════════════════════════════════════════════
    elements += section("9. Wallet System", styles)

    elements += subsection("9.1 HD Wallet Architecture", styles)
    elements += body(
        "IOTAI wallets implement Hierarchical Deterministic (HD) key derivation, allowing "
        "multiple addresses to be generated from a single master seed. The derivation path "
        "follows a simplified scheme using BLAKE3-keyed hashing:",
        styles
    )
    elements += code(
        "master_seed (256-bit)\n"
        "  |-- index 0 --> address_0 (default)\n"
        "  |-- index 1 --> address_1\n"
        "  |-- index 2 --> address_2\n"
        "  |-- ...      --> address_n",
        styles
    )
    elements += body(
        "This enables several important use cases for AI agents: address-per-transaction "
        "for privacy, address-per-service for accounting separation, and address rotation "
        "on suspected compromise.",
        styles
    )

    elements += subsection("9.2 BIP39 Seed Phrases", styles)
    elements += body(
        "Wallet creation generates a 12-word mnemonic seed phrase following BIP39 conventions. "
        "The seed phrase serves as a human-readable backup of the master seed, enabling wallet "
        "recovery across devices and implementations. The custom wordlist is optimized for "
        "clarity and distinctness to minimize transcription errors.",
        styles
    )

    elements += subsection("9.3 CLI Interface", styles)
    elements += body(
        "A command-line wallet interface enables direct interaction with the IOTAI network:",
        styles
    )
    elements += code(
        "iotai-wallet create     # Generate new 12-word wallet\n"
        "iotai-wallet restore    # Restore from seed phrase\n"
        "iotai-wallet balance    # Check IOTAI balance\n"
        "iotai-wallet send       # Transfer tokens\n"
        "iotai-wallet history    # View transaction history\n"
        "iotai-wallet info       # Display wallet details",
        styles
    )

    elements.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 10. DATA LAYER
    # ═══════════════════════════════════════════════
    elements += section("10. Data Layer", styles)

    elements += subsection("10.1 On-Chain Data Storage", styles)
    elements += body(
        "Beyond value transfer, IOTAI supports arbitrary data storage through data transactions. "
        "A data transaction has type 'data', zero transfer amount, and carries a metadata object "
        "of arbitrary structure. Data transactions participate in the DAG consensus like any "
        "other transaction, benefiting from the same immutability and confirmation guarantees.",
        styles
    )
    elements += body(
        "This capability is fundamental to the AI agent economy, enabling on-chain service "
        "advertisements, job postings, result attestations, and inter-agent messaging without "
        "external infrastructure.",
        styles
    )

    elements += subsection("10.2 Query Interface", styles)
    elements += body(
        "The data query API provides two search modalities:",
        styles
    )
    elements += body(
        "<b>Structured queries</b> filter by sender address, metadata key-value pairs, and "
        "time ranges using AND logic. Results are sorted by timestamp (newest first) and support "
        "pagination through limit/offset parameters.",
        styles
    )
    elements += body(
        "<b>Full-text search</b> performs case-insensitive substring matching across the entire "
        "JSON-serialized metadata of all data transactions. This enables broad discovery of "
        "relevant data without prior knowledge of the metadata schema.",
        styles
    )

    elements += subsection("10.3 Agent Communication Patterns", styles)
    elements += body(
        "Data transactions enable several agent communication patterns:",
        styles
    )
    elements += bullet_list([
        "<b>Service marketplace:</b> Agents advertise capabilities and pricing via data transactions; "
        "other agents discover services through search queries.",
        "<b>Job protocol:</b> Agent A posts a job request with parameters and reward; Agent B "
        "discovers it, performs the work, posts a result attestation; Agent A verifies and sends payment.",
        "<b>Oracle feeds:</b> Agents periodically post external data (prices, weather, API status) "
        "as data transactions, creating an on-chain oracle accessible to all agents.",
        "<b>State channels:</b> Agents use metadata to negotiate off-chain, with periodic "
        "DAG checkpoints for dispute resolution.",
    ], styles)

    elements.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 11. SECURITY ANALYSIS
    # ═══════════════════════════════════════════════
    elements += section("11. Security Analysis", styles)

    elements += subsection("11.1 Threat Model", styles)
    elements += body(
        "IOTAI's security model assumes a network where the majority of nodes are honest, but "
        "individual nodes may be malicious. The system defends against the following attack vectors:",
        styles
    )

    elements.append(make_table(
        ["Attack", "Defense", "Mechanism"],
        [
            ["Transaction replay", "Nonce uniqueness + persistence", "Used nonces tracked across restarts"],
            ["Double spending", "Pending outflow tracking", "Sum of unconfirmed txs checked"],
            ["Sybil (faucet)", "Multi-layer biometric verification", "Embedding similarity + IP + address"],
            ["Signature forgery", "Ed25519 (128-bit security)", "Computationally infeasible"],
            ["Hash collision", "BLAKE3 (128-bit birthday bound)", "Negligible probability"],
            ["Eclipse attack", "Multiple discovery mechanisms", "mDNS + DHT + bootstrap"],
            ["Timestamp manipulation", "+/- 5 minute tolerance window", "Reject future/past timestamps"],
        ],
        [100, 140, 200]
    ))

    elements += subsection("11.2 Cryptographic Guarantees", styles)

    elements.append(make_table(
        ["Property", "Guarantee", "Achieved By"],
        [
            ["Unforgeability", "Only key holder can sign", "Ed25519 discrete log hardness"],
            ["Non-repudiation", "Signer cannot deny authorship", "Public key verifiability"],
            ["Integrity", "Tampering is detectable", "BLAKE3 hash in signature scope"],
            ["Replay resistance", "Transactions cannot be resubmitted", "Unique nonce per transaction"],
            ["Address privacy", "Public key not exposed in address", "BLAKE3 one-way hash"],
        ],
        [100, 160, 180]
    ))

    elements += subsection("11.3 Network Security", styles)
    elements += body(
        "All peer-to-peer communication is encrypted using the NOISE protocol framework with "
        "ChaCha20-Poly1305 authenticated encryption. This provides confidentiality and integrity "
        "of all network messages, preventing eavesdropping and man-in-the-middle attacks. "
        "Peer identity is established through Ed25519 key exchange during the NOISE handshake, "
        "ensuring that each peer's identity is cryptographically verified.",
        styles
    )

    elements.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 12. PERSISTENCE AND FAULT TOLERANCE
    # ═══════════════════════════════════════════════
    elements += section("12. Persistence and Fault Tolerance", styles)

    elements += subsection("12.1 Dual-Layer Storage", styles)
    elements += body(
        "IOTAI implements a dual-layer persistence architecture to survive both process restarts "
        "and infrastructure failures:",
        styles
    )
    elements += body(
        "<b>Layer 1 - Local Disk:</b> The complete DAG state is serialized to JSON and written "
        "to disk every 30 seconds. This provides fast recovery after process restarts without "
        "network access.",
        styles
    )
    elements += body(
        "<b>Layer 2 - GitHub API:</b> As a secondary backup, the serialized state is pushed "
        "to a dedicated GitHub repository branch using the Contents API. This survives "
        "infrastructure-level failures (server migration, disk loss, container redeployment) "
        "and provides an auditable history of state snapshots.",
        styles
    )
    elements += body(
        "On startup, the node attempts recovery in priority order: disk first, then GitHub, "
        "finally initializing a fresh DAG with genesis transaction if both sources are empty.",
        styles
    )

    elements += subsection("12.2 State Recovery", styles)
    elements += body(
        "State restoration follows a careful sequence to maintain consistency: the genesis "
        "transaction is identified and restored first, then remaining transactions are imported "
        "in timestamp order. Balance validation is skipped during restoration (since transactions "
        "are already consensus-confirmed), preventing false rejections from temporal ordering "
        "differences. The tips set is reconstructed by identifying transactions with no children, "
        "and the nonce set is rebuilt both from the serialized state and from transaction records "
        "for redundancy.",
        styles
    )

    elements.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 13. FUTURE WORK
    # ═══════════════════════════════════════════════
    elements += section("13. Future Work", styles)

    elements += body(
        "Several enhancements are planned for future protocol versions:",
        styles
    )
    elements += bullet_list([
        "<b>Transaction fees:</b> Optional fees to incentivize node operators and prioritize "
        "time-sensitive transactions during high network load.",
        "<b>DAG pruning:</b> Mechanism to archive confirmed transactions beyond a configurable "
        "depth, reducing storage requirements for full nodes.",
        "<b>WebSocket API:</b> Bidirectional real-time communication as a complement to the "
        "unidirectional SSE stream.",
        "<b>WASM smart contracts:</b> On-chain programmable logic executed by validators, "
        "enabling trustless multi-party agent coordination.",
        "<b>State channels:</b> Off-chain transaction processing with on-chain settlement for "
        "high-frequency micro-payments between trusted agent pairs.",
        "<b>Mobile SDK:</b> Native libraries for iOS and Android to enable mobile agent "
        "participation in the IOTAI network.",
        "<b>Balance indexing:</b> Dedicated index structure to replace full DAG traversal for "
        "balance computation, improving query performance at scale.",
        "<b>Cross-chain bridges:</b> Interoperability with Ethereum, Solana, and other networks "
        "to enable value transfer between ecosystems.",
    ], styles)

    elements.append(PageBreak())

    # ═══════════════════════════════════════════════
    # 14. CONCLUSION
    # ═══════════════════════════════════════════════
    elements += section("14. Conclusion", styles)

    elements += body(
        "IOTAI presents a purpose-built cryptocurrency for the emerging AI agent economy. By "
        "adopting a DAG-based architecture, the protocol eliminates the fundamental limitations "
        "of blockchain-based systems for machine-to-machine payments: transaction fees, "
        "confirmation latency, and sequential processing bottlenecks.",
        styles
    )
    elements += body(
        "The protocol's key contributions include:",
        styles
    )
    elements += bullet_list([
        "A feeless, near-instant DAG consensus mechanism where each transaction strengthens "
        "network security by validating previous transactions.",
        "A Proof-of-Personhood faucet that ensures equitable token distribution through "
        "privacy-preserving biometric verification, resistant to Sybil attacks.",
        "An API-first design with RESTful endpoints and real-time event streaming, enabling "
        "AI agents to participate as autonomous economic actors.",
        "A comprehensive data layer that supports on-chain storage and querying, enabling "
        "inter-agent communication, service marketplaces, and oracle feeds.",
        "A dual-layer persistence architecture that provides fault tolerance across "
        "infrastructure failures without compromising decentralization.",
    ], styles)
    elements += body(
        "As AI systems become increasingly autonomous and economically active, the need for "
        "machine-native payment infrastructure becomes critical. IOTAI provides this foundation, "
        "enabling a future where AI agents can transact value, coordinate services, and "
        "participate in decentralized markets with the same ease that they currently process "
        "data and generate content.",
        styles
    )

    elements.append(Spacer(1, 30))
    elements.append(HRFlowable(width="40%", thickness=1, color=ACCENT, hAlign='CENTER'))
    elements.append(Spacer(1, 10))
    elements += body(
        "<i>IOTAI is open source. The complete implementation, including all modules described "
        "in this paper, is available at github.com/JOSEFON31/IOTAI.</i>",
        styles
    )

    return elements


def main():
    styles = get_styles()

    doc = BaseDocTemplate(
        OUTPUT_PATH,
        pagesize=letter,
        leftMargin=72,
        rightMargin=72,
        topMargin=72,
        bottomMargin=72,
        title="IOTAI: A DAG-Based Cryptocurrency for Autonomous AI Agent Payments",
        author="Jose Fonseca",
        subject="IOTAI Whitepaper v1.0",
        creator="IOTAI Project",
    )

    # Cover frame (with margins for text content)
    cover_frame = Frame(72, 72, letter[0] - 144, letter[1] - 144, id='cover')
    cover_template = PageTemplate(id='cover', frames=[cover_frame], onPage=draw_cover_page)

    # Content frame (with margins)
    content_frame = Frame(72, 72, letter[0] - 144, letter[1] - 144, id='content')
    content_template = PageTemplate(id='content', frames=[content_frame])

    doc.addPageTemplates([cover_template, content_template])

    # Build story
    story = []

    # Cover page
    story += build_cover(styles)

    # Switch to content template
    from reportlab.platypus.doctemplate import NextPageTemplate
    story.append(NextPageTemplate('content'))

    # Table of contents
    story += build_toc(styles)

    # Main content
    story += build_content(styles)

    # Build PDF with numbered canvas
    doc.build(story, canvasmaker=NumberedCanvas)
    print(f"Whitepaper generated: {OUTPUT_PATH}")
    print(f"File size: {os.path.getsize(OUTPUT_PATH) / 1024:.1f} KB")


if __name__ == '__main__':
    main()
