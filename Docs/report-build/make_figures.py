"""Draws the report's diagrams and chart as SVG (no plotting library needed).

    python make_figures.py            -> Docs/report-build/figures/fig*.svg

Sizes are chosen for print: Figures 1-2 fill a landscape page (about 8.5 in wide), the others a
portrait page (6.5 in); text is sized to print at roughly 6-8 pt or larger. The PNGs used in the
report are rendered from these SVGs with headless Chrome (figure-jobs.mjs). Every component and
number comes from the deployed system (infra-cdk/lib/*.ts, bin/app.ts) or from the evidence
captured on 2026-10-15 (result/report-evidence/2026-10-15/), not from the Phase-I design.
"""
from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(__file__).parent / 'figures'
OUT.mkdir(exist_ok=True)
FONT = "font-family:'Segoe UI',Arial,sans-serif"

C = {
    'compute': '#ED7100', 'db': '#3B48CC', 'net': '#8C4FFF', 'integ': '#E7157B', 'ml': '#01A88D',
    'storage': '#7AA116', 'sec': '#DD344C', 'mgmt': '#E7157B', 'ext': '#545B64', 'stream': '#8C4FFF',
}


class Svg:
    def __init__(self, w, h, title=28, detail=22):
        self.w, self.h, self.parts = w, h, []
        self.T, self.D = title, detail

    def add(self, s):
        self.parts.append(s)

    def rect(self, x, y, w, h, stroke, fill='#ffffff', sw=2.5, rx=10, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ''
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')

    def text(self, x, y, s, size, weight='normal', fill='#16191f', anchor='start', italic=False, rotate=None):
        st = ' font-style="italic"' if italic else ''
        rot = f' transform="rotate({rotate} {x} {y})"' if rotate is not None else ''
        self.add(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}"{st}{rot} style="{FONT}">{escape(s)}</text>')

    def box(self, x, y, w, h, color, title, lines=(), center=False, title_size=None, line_size=None):
        ts, ls = title_size or self.T, line_size or self.D
        self.rect(x, y, w, h, color)
        self.add(f'<rect x="{x}" y="{y}" width="9" height="{h}" rx="3" fill="{color}"/>')
        tx = x + w / 2 + 4 if center else x + 22
        anchor = 'middle' if center else 'start'
        ty = y + ts + 10
        for t in ([title] if isinstance(title, str) else title):
            self.text(tx, ty, t, ts, 'bold', anchor=anchor)
            ty += ts + 6
        ty += 2
        for ln in lines:
            self.text(tx, ty, ln, ls, fill='#3b4047', anchor=anchor)
            ty += ls + 6

    def group(self, x, y, w, h, color, label, fill, size=24, dash=None):
        self.rect(x, y, w, h, color, fill, sw=3, rx=14, dash=dash)
        self.text(x + 16, y + size + 8, label, size, 'bold', fill=color)

    def arrow(self, pts, dash=None, sw=3.5):
        d = ' '.join(f'{"M" if i == 0 else "L"}{px},{py}' for i, (px, py) in enumerate(pts))
        da = f' stroke-dasharray="{dash}"' if dash else ''
        self.add(f'<path d="{d}" fill="none" stroke="#232f3e" stroke-width="{sw}"{da} marker-end="url(#ah)"/>')

    def num(self, x, y, n):
        self.add(f'<circle cx="{x}" cy="{y}" r="19" fill="#232f3e" stroke="#ffffff" stroke-width="2.5"/>')
        self.text(x, y + 7, str(n), 20, 'bold', fill='#ffffff', anchor='middle')

    def save(self, name):
        defs = ('<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
                '<path d="M0,0 L10,5 L0,10 z" fill="#232f3e"/></marker></defs>')
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" viewBox="0 0 {self.w} {self.h}">'
               f'<rect width="100%" height="100%" fill="#ffffff"/>{defs}{"".join(self.parts)}</svg>')
        (OUT / name).write_text(svg, encoding='utf-8')
        print('wrote', name, f'{self.w}x{self.h}')


# ------------------------------------------------------------------------------------------------
# Figure 1: AWS cloud architecture (as deployed) - landscape page
def fig1():
    s = Svg(2500, 1650, title=27, detail=22)
    s.box(10, 80, 245, 170, C['ext'], ['Engineers', '/ SRE'], ['web browser'])
    s.box(2255, 70, 235, 300, C['ext'], ['Alert', 'recipients'], ['e-mail', 'Slack', 'PagerDuty'])
    s.group(272, 22, 1966, 1612, '#232F3E', 'AWS Cloud · us-east-1', '#ffffff', size=24)

    # regional row (outside the VPC)
    top = [
        (290, 225, C['net'], ['Amazon', 'CloudFront'], ['HTTPS, headers', 'origin secret']),
        (535, 210, C['storage'], ['Amazon S3'], ['dashboard SPA', 'private (OAC)']),
        (765, 225, C['integ'], ['Amazon API', 'Gateway'], ['HTTP API', '4 GET routes']),
        (1010, 215, C['compute'], ['Lambda', 'api.incidents'], ['read-only']),
        (1245, 285, C['db'], ['Amazon', 'DynamoDB'], ['incidents + state', 'Streams, TTL, KMS']),
        (1550, 215, C['compute'], ['Lambda', 'dispatcher'], ['stream ->', 'classify']),
        (1785, 215, C['integ'], ['Amazon SNS'], ['rca-alerts', '(KMS)']),
        (2020, 200, C['compute'], ['Lambda x2'], ['Slack,', 'PagerDuty']),
    ]
    for x, w, col, t, d in top:
        s.box(x, 70, w, 185, col, t, d)

    # VPC
    s.group(290, 300, 1325, 1316, C['net'], 'VPC 10.0.0.0/16 · 2 Availability Zones', '#fbf8ff', size=24)
    s.group(306, 345, 1293, 110, '#7AA116', 'Public', '#f2f8e6', size=21)
    s.box(420, 360, 240, 80, C['net'], 'Internet gateway', [], title_size=22)
    s.box(690, 360, 230, 80, C['net'], 'NAT gateway (1)', [], title_size=22)
    s.group(306, 470, 1293, 650, '#00A4A6', 'Private-app (outbound via NAT)', '#ebf8f8', size=21)
    s.group(322, 515, 480, 590, C['compute'], 'Amazon EKS 1.35 · 2 nodes', '#fff8f2', size=23)
    s.box(340, 570, 445, 200, C['compute'], 'Online Boutique', ['11 services + load generator', '7 emit OpenTelemetry spans', 'fault target: product catalogue'])
    s.box(340, 880, 445, 200, C['compute'], 'OTel Collector', ['DaemonSet, 1 pod per node', 'OTLP in, Kafka out (TLS)'])
    s.box(830, 515, 210, 185, C['compute'], ['Lambda', 'transformer'], ['MSK trigger'])
    s.box(1060, 515, 210, 185, C['compute'], ['Lambda', 'api.topology'], ['read-only'])
    s.box(1290, 515, 230, 185, C['compute'], ['Lambda', 'scorer'], ['every minute'])
    s.rect(1535, 490, 56, 615, C['net'], '#f3ecff', rx=8)
    s.text(1556, 798, 'Interface endpoints: SageMaker Runtime, SNS, Lambda, STS', 19, 'bold', fill=C['net'], anchor='middle', rotate=-90)
    s.text(1580, 798, 'Gateway endpoints: S3, DynamoDB', 19, 'bold', fill=C['net'], anchor='middle', rotate=-90)
    s.group(306, 1135, 1293, 465, '#147EBA', 'Private-data (no internet route)', '#eaf3fb', size=21)
    s.box(322, 1185, 480, 230, C['stream'], 'Amazon MSK', ['Kafka 3.9.x, 2 brokers', 'one per AZ, TLS 9094', 'topic otel.traces'])
    s.box(830, 1185, 690, 230, C['db'], 'Amazon Neptune 1.4.8.0', ['writer db.t4g.medium', 'IAM auth (SigV4), port 8182', 'services = vertices, calls = edges'])
    s.rect(322, 1435, 1262, 150, '#879196', '#f4f5f6', rx=8)
    s.text(342, 1478, 'Security groups: 9094 and 8182 only from the private-app subnets.', 22, fill='#2b3036')
    s.text(342, 1514, 'TLS in transit; KMS keys at rest (Neptune, DynamoDB, SNS).', 22, fill='#2b3036')
    s.text(342, 1550, 'One least-privilege IAM role per function.', 22, fill='#2b3036')

    # right column (regional services)
    right = [
        (300, 115, C['integ'], 'Amazon EventBridge', ['schedule: every minute']),
        (440, 150, C['ml'], 'Amazon SageMaker', ['serverless endpoint', 'GNN root-cause ranking']),
        (615, 115, C['mgmt'], 'Amazon CloudWatch', ['logs, metrics, DLQ alarm']),
        (755, 150, C['sec'], 'IAM · KMS · Secrets', ['least-privilege roles,', 'customer-managed keys']),
        (930, 115, C['mgmt'], 'CloudFormation (CDK)', ['11 stacks: npm run up / down']),
        (1070, 115, C['mgmt'], 'AWS Budgets', ['USD 50 monthly alert']),
    ]
    for y, h, col, t, d in right:
        s.box(1640, y, 580, h, col, t, d)
    # legend
    s.rect(1640, 1210, 580, 405, '#d5dbdb', '#fafbfb', rx=10)
    s.text(1660, 1248, 'Flows', 23, 'bold')
    legend = ['1  spans (OTLP)', '2  Kafka over TLS', '3  MSK trigger (batches)', '4  Gremlin upserts (SigV4)',
              '5  schedule, every minute', '6  read edge counters', '7  rank, only if >= 2x baseline',
              '8  incident + state transaction', '9  stream -> SNS -> alerts', '10 dashboard and API']
    for i, ln in enumerate(legend):
        s.text(1660, 1284 + i * 33, ln, 21, fill='#2b3036')

    # flows
    s.arrow([(255, 165), (290, 165)]); s.num(272, 285, 10)
    s.arrow([(515, 160), (535, 160)])
    s.arrow([(402, 255), (402, 278), (860, 278), (860, 255)])
    s.arrow([(990, 160), (1010, 160)])
    s.arrow([(1225, 160), (1245, 160)])
    s.arrow([(1530, 160), (1550, 160)]); s.num(1540, 48, 9)
    s.arrow([(1765, 160), (1785, 160)])
    s.arrow([(2000, 160), (2020, 160)])
    s.arrow([(2220, 160), (2255, 160)])
    s.arrow([(950, 255), (950, 490), (1165, 490), (1165, 515)])
    s.arrow([(760, 770), (760, 880)]); s.num(728, 826, 1)
    s.arrow([(760, 1080), (760, 1185)]); s.num(728, 1160, 2)
    s.arrow([(802, 1300), (816, 1300), (816, 608), (830, 608)]); s.num(816, 1000, 3)
    s.arrow([(935, 700), (935, 1185)]); s.num(935, 960, 4)
    s.arrow([(1165, 700), (1165, 1185)], dash='10,7'); s.num(1165, 1060, 10)
    s.arrow([(1640, 357), (1470, 357), (1470, 515)]); s.num(1600, 357, 5)
    s.arrow([(1430, 700), (1430, 1185)], dash='10,7'); s.num(1430, 960, 6)
    s.arrow([(1520, 640), (1640, 540)]); s.num(1617, 600, 7)
    s.arrow([(1320, 515), (1320, 255)]); s.num(1320, 400, 8)
    s.save('fig1-aws-architecture.svg')


# ------------------------------------------------------------------------------------------------
# Figure 2: complete system architecture - landscape page
def fig2():
    s = Svg(2500, 1620, title=26, detail=21)
    bands = ['Application layer', 'Telemetry and streaming', 'Graph construction', 'Intelligence (every minute)',
             'Incident state', 'Delivery and visualisation']
    for i, label in enumerate(bands):
        y = 15 + i * 232
        s.rect(15, y, 1620, 220, '#d5dbdb', '#fafbfb', sw=1.5, rx=12)
        s.text(32, y + 30, label, 22, 'bold', fill='#545b64')
    Y = lambda i: 15 + i * 232 + 45      # box top in band i
    H = 160
    s.box(32, Y(0), 600, H, C['ext'], 'Users and load generator', ['browse, add to cart, check out'])
    s.box(820, Y(0), 795, H, C['compute'], 'Online Boutique on Amazon EKS', ['frontend, checkout, payment, currency, email,', 'product catalogue, recommendation, cart, ...'])
    s.arrow([(632, Y(0) + 80), (820, Y(0) + 80)])
    s.box(820, Y(1), 795, H, C['compute'], 'OpenTelemetry SDK + Collector', ['spans: caller, callee RPC, start and end time', 'exported as OTLP/JSON'])
    s.box(32, Y(1), 600, H, C['stream'], 'Kafka topic otel.traces (MSK)', ['buffer for bursty trace volume'])
    s.arrow([(1217, Y(0) + H), (1217, Y(1))])
    s.arrow([(820, Y(1) + 80), (632, Y(1) + 80)])
    s.box(32, Y(2), 600, H, C['compute'], 'Graph transformer (Lambda)', ['client span -> caller -> callee edge', 'batched, idempotent upserts'])
    s.box(820, Y(2), 795, H, C['db'], 'Knowledge graph (Neptune)', ['vertices = services; edges = calls with call_count,', 'latency sum, recent average, latency histogram'])
    s.arrow([(332, Y(1) + H), (332, Y(2))])
    s.arrow([(632, Y(2) + 80), (820, Y(2) + 80)])
    s.box(32, Y(3), 520, H, C['compute'], 'Scorer (Lambda)', ['window = counters now minus', 'counters at the previous run'])
    s.box(610, Y(3), 450, H, C['compute'], 'Gate', ['any service >= 2x its', 'learned baseline?'])
    s.box(1115, Y(3), 500, H, C['ml'], 'GNN ranking (SageMaker)', ['root cause, blast radius,', 'services at risk'])
    s.arrow([(1217, Y(2) + H), (1217, Y(2) + H + 31), (470, Y(2) + H + 31), (470, Y(3))])
    s.arrow([(552, Y(3) + 80), (610, Y(3) + 80)])
    s.arrow([(1060, Y(3) + 80), (1115, Y(3) + 80)])
    s.text(1087, Y(3) + 66, 'yes', 20, 'bold', fill=C['ml'], anchor='middle')
    s.box(32, Y(4), 600, H, C['compute'], 'Incident lifecycle', ['open after 2 implicated windows,', 'resolve after 3 clean windows'])
    s.box(820, Y(4), 795, H, C['db'], 'DynamoDB rca-incidents', ['state + incident in one transaction', '(no duplicates); 30-day TTL; stream'])
    s.arrow([(1365, Y(3) + H), (1365, Y(3) + H + 31), (332, Y(3) + H + 31), (332, Y(4))])
    s.arrow([(632, Y(4) + 80), (820, Y(4) + 80)])
    s.box(32, Y(5), 600, H, C['integ'], 'Dashboard (CloudFront + API)', ['live topology, recent latency,', '"Slow now" marker, incidents'])
    s.box(820, Y(5), 795, H, C['integ'], 'Alerts (SNS)', ['one alert when an incident opens, one when it', 'resolves: Slack, PagerDuty, e-mail; DLQ'])
    s.arrow([(1217, Y(4) + H), (1217, Y(5))])
    s.arrow([(920, Y(4) + H), (920, Y(4) + H + 31), (332, Y(4) + H + 31), (332, Y(5))])
    s.box(32, 1415, 1583, 105, C['ext'], 'On-call engineers / SRE', ['one alert per incident naming the likely root cause'], center=True)
    s.arrow([(332, Y(5) + H), (332, 1415)])
    s.arrow([(1217, Y(5) + H), (1217, 1415)])

    s.group(1675, 15, 805, 1000, C['ml'], 'Offline model pipeline', '#effaf8', size=24)
    steps = [
        ('Alibaba MSCallGraph, part 0', ['6,088,846 call records']),
        ('Preprocessing', ['RPC de-duplication; 7,384 services,', '16,115 edges']),
        ('Synthetic fault injection', ['root cause, upstream ripple, noise']),
        ('GNN training (PyTorch Geometric)', ['GATv2Conv + 3 x SAGEConv']),
        ('Fine-tune on small graphs', ['gate: top-1 >= 60 %, top-3 >= 90 %']),
        ('Model artefact', ['built only if the gate passes']),
    ]
    y = 70
    last_top, last_h = y, 0
    for i, (t, lines) in enumerate(steps):
        h = 52 + 27 * len(lines) + 8
        s.box(1695, y, 765, h, C['ml'], t, lines, title_size=23, line_size=20)
        if i < len(steps) - 1:
            s.arrow([(2077, y + h), (2077, y + h + 22)])
        last_top, last_h = y, h
        y += h + 22
    s.arrow([(1695, last_top + last_h / 2), (1615, Y(3) + 80)])

    s.group(1675, 1040, 805, 565, C['mgmt'], 'Operations and feedback', '#fdf2f7', size=24)
    ops = [('Amazon CloudWatch', 'logs and metrics of every component', C['mgmt']),
           ('Verification scripts', 'npm run verify:* per stage', C['mgmt']),
           ('Fault injection (kubectl)', 'real latency or CPU faults, recorded undo', C['compute']),
           ('Infrastructure as code (CDK)', 'npm run up / npm run down', C['mgmt'])]
    for i, (t, d, col) in enumerate(ops):
        s.box(1695, 1095 + i * 125, 765, 108, col, t, [d], title_size=23, line_size=20)
    fy = 1095 + 2 * 125 + 54
    s.arrow([(2460, fy), (2488, fy), (2488, 6), (1650, 6), (1650, Y(0) + 40), (1615, Y(0) + 40)], dash='10,7')
    s.save('fig2-system-architecture.svg')


# ------------------------------------------------------------------------------------------------
# Figure 3: the live fault, minute by minute (2026-10-15, UTC) - portrait
def fig3():
    s = Svg(1600, 860)
    x0, x1 = 90, 1560
    X = lambda mm, ss=0: x0 + (mm + ss / 60) / 19 * (x1 - x0)          # minutes after 17:00
    s.text(x0, 40, 'Live fault test, 15 October 2026 (UTC)', 28, 'bold')
    bands = [(1 + 9 / 60, 11, '#7AA116', '#eef6e1', 'healthy soak', '#4d6b10'), (11, 13 + 7 / 60, '#DD344C', '#fde8eb', 'fault', '#a3162b'),
             (13 + 7 / 60, 16 + 59 / 60, '#ED7100', '#fff1e3', 'recovering', '#9a4a00'), (16 + 59 / 60, 19, '#7AA116', '#eef6e1', 'healthy', '#4d6b10')]
    for a, b, stroke, fill, label, col in bands:
        s.rect(X(a), 80, X(b) - X(a), 64, stroke, fill, rx=6)
        s.text((X(a) + X(b)) / 2, 122, label, 24, 'bold', fill=col, anchor='middle')
    s.add(f'<line x1="{x0}" y1="190" x2="{x1}" y2="190" stroke="#232f3e" stroke-width="3"/>')
    for m in range(0, 20):
        s.add(f'<line x1="{X(m)}" y1="182" x2="{X(m)}" y2="198" stroke="#232f3e" stroke-width="2"/>')
        if m in (0, 3, 6, 9, 15, 18):
            s.text(X(m), 228, f'17:{m:02d}', 21, anchor='middle', fill='#414750')
    events = [(1, 9), (11, 8), (12, 8), (13, 7), (16, 59)]
    offsets = [0, 0, 44, 0, 0]
    for i, ((mm, ss), off) in enumerate(zip(events, offsets), 1):
        s.add(f'<line x1="{X(mm, ss)}" y1="144" x2="{X(mm, ss)}" y2="{262 + off - 19}" stroke="#232f3e" stroke-width="2.5"/>')
        s.num(X(mm, ss), 262 + off, i)
    runs = [(11, 8, True), (12, 8, True), (12, 59, True), (14, 7, True), (14, 59, False), (15, 59, False), (16, 59, False), (17, 59, False), (18, 59, False)]
    s.text(x0, 368, 'Scorer runs:', 21, 'bold')
    for mm, ss, model in runs:
        s.add(f'<circle cx="{X(mm, ss)}" cy="361" r="11" fill="{"#01A88D" if model else "#ffffff"}" stroke="#01A88D" stroke-width="3.5"/>')
    s.text(x0, 404, 'filled = model called (a service at least 2x its baseline); open = no model call', 21, fill='#414750')
    lines = [
        '1  17:01  demo starts: productcatalogservice baseline 0.88 ms (28 windows)',
        '2  17:11  first scoring window after the fault implicates productcatalogservice',
        '3  17:12  second implicated window: incident OPENED, "opened" alert sent',
        '4  17:13  fault cleared (EXTRA_LATENCY removed)',
        '5  17:17  third clean window: incident RESOLVED, "resolved" alert sent',
    ]
    for i, ln in enumerate(lines):
        s.text(x0, 460 + i * 36, ln, 22)
    s.rect(x0 - 10, 650, x1 - x0 + 20, 190, '#d5dbdb', '#fafbfb', rx=10)
    meas = [
        'Latency into the service: 0.88 ms -> 301.29 ms (x344); traffic 982 -> 619 calls/min.',
        'Root cause productcatalogservice ranked #1 (peak score 0.950); blast radius recommendationservice.',
        'Opened 1.1 min after the fault; resolved 3.9 min after clearing; one alert each way.',
        'SNS 3 delivered, 0 failed; DLQ empty; no scorer errors (npm run verify:demo, 19/19).',
    ]
    for i, ln in enumerate(meas):
        s.text(x0 + 10, 692 + i * 40, ln, 22)
    s.save('fig3-fault-timeline.svg')


# ------------------------------------------------------------------------------------------------
# Figure 4: the GNN and the root-cause fingerprint - portrait
def fig4():
    s = Svg(1600, 900, title=25, detail=21)
    s.box(20, 20, 1560, 150, C['db'], 'Inputs per scoring window', [
        'Node (7 features): call volume as caller and as callee, in-degree, out-degree; own latency deviation;',
        'maximum and mean deviation of the services it calls.   Edge (9): average and p95 latency, log volume, RPC type.'])
    layers = [('GATv2Conv', ['attention over', 'neighbours,', 'uses edge features']), ('3 x SAGEConv', ['neighbourhood', 'aggregation;', 'reach: 4 hops']),
              ('Linear', ['one score', 'per service']), ('Softmax', ['ranking over services;', 'cross-entropy on the', 'injected root cause'])]
    x = 20
    widths = [360, 360, 300, 440]
    for i, ((t, d), w) in enumerate(zip(layers, widths)):
        s.box(x, 230, w, 180, C['ml'], t, d)
        if i > 0:
            s.arrow([(x - 33, 320), (x, 320)])
        x += w + 33
    s.arrow([(200, 170), (200, 228)])
    s.text(20, 488, 'Why it separates cause from symptom (calls A -> B -> C, fault at C)', 25, 'bold')
    hdr = ['Service', 'Own deviation', 'Deviation of what it calls', 'Interpretation']
    rows = [['A', 'medium', 'high', 'slow because something it calls is slow'],
            ['B', 'high', 'very high', 'relays the fault upstream'],
            ['C', 'very high', 'normal', 'slow while what it calls is fine: root cause']]
    cx, cw = [20, 200, 460, 830], [180, 260, 370, 750]
    y = 515
    for j, h in enumerate(hdr):
        s.rect(cx[j], y, cw[j], 58, '#879196', '#e9ecef', rx=0, sw=1.5)
        s.text(cx[j] + 14, y + 38, h, 22, 'bold')
    for r in rows:
        y += 58
        for j, v in enumerate(r):
            hl = r[0] == 'C' and j in (2, 3)
            s.rect(cx[j], y, cw[j], 58, '#879196', '#e6f6f3' if hl else '#ffffff', rx=0, sw=1.5)
            s.text(cx[j] + 14, y + 38, v, 22, 'bold' if hl else 'normal')
    s.text(20, 810, 'Labels come from synthetic fault injection on the real Alibaba call graph;', 21, fill='#414750', italic=True)
    s.text(20, 842, 'the trace data has no failure column.', 21, fill='#414750', italic=True)
    s.save('fig4-gnn.svg')


# ------------------------------------------------------------------------------------------------
# Figure 5: ranking accuracy against baselines (deployed weights, 600 scenarios each) - portrait
def fig5():
    s = Svg(1500, 820)
    groups = [('Proportional', 'top-1', 65.5, 37.3, 9.1), ('Proportional', 'top-3', 98.7, 98.0, 27.3),
              ('Faithful', 'top-1', 40.7, 21.2, 9.1), ('Faithful', 'top-3', 81.7, 64.7, 27.3)]
    series = [('GNN (deployed)', '#01A88D'), ('Trivial: largest own deviation', '#879196'), ('Random', '#c8cfd3')]
    left, base, height = 110, 650, 480
    for v in range(0, 101, 20):
        y = base - v / 100 * height
        s.add(f'<line x1="{left}" y1="{y}" x2="1480" y2="{y}" stroke="#e1e4e8" stroke-width="1.5"/>')
        s.text(left - 14, y + 7, f'{v}%', 21, anchor='end', fill='#545b64')
    s.add(f'<line x1="{left}" y1="{base}" x2="1480" y2="{base}" stroke="#232f3e" stroke-width="2"/>')
    gw = 340
    for gi, (scen, k, *vals) in enumerate(groups):
        gx = left + 30 + gi * gw
        for si, v in enumerate(vals):
            bx = gx + si * 95
            bh = v / 100 * height
            s.rect(bx, base - bh, 82, bh, series[si][1], series[si][1], rx=3, sw=1)
            s.text(bx + 41, base - bh - 10, f'{v:.1f}', 22, 'bold', anchor='middle')
        s.text(gx + 136, base + 40, f'{scen}, {k}', 23, 'bold', anchor='middle')
    for i, (name, col) in enumerate(series):
        x = left + [0, 330, 830][i]
        s.rect(x, 60, 30, 30, col, col, rx=3, sw=1)
        s.text(x + 42, 84, name, 23)
    s.text(left, 760, 'Boutique-shaped graph, 12 services (11 candidates), 600 synthetic scenarios per mode;', 20, fill='#414750', italic=True)
    s.text(left, 790, 'source: src/ml-engine/models/boutique_eval.json.', 20, fill='#414750', italic=True)
    s.save('fig5-model-accuracy.svg')


if __name__ == '__main__':
    fig1(); fig2(); fig3(); fig4(); fig5()
