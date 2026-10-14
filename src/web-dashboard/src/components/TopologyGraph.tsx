import cytoscape, { type Core, type StylesheetJson } from 'cytoscape';
import { useEffect, useMemo, useRef } from 'react';
import { layoutKey, STATUS, STATUS_ORDER, toElements } from '../graph';
import { layeredPositions } from '../layout';
import type { TopologyResponse } from '../types';

interface Props {
  topology: TopologyResponse;
  selectedNode: string | undefined;
  /** Services to keep in focus (an incident's root cause, blast radius, callers); the rest dim. */
  highlighted: Set<string>;
  onSelectNode: (id: string | undefined) => void;
}

/** Little breathing room on a phone-width canvas, where every pixel is label space. */
function fitPadding(el: HTMLElement | null): number {
  return (el?.clientWidth ?? 1000) < 600 ? 12 : 50;
}

/** Resolves the design tokens from CSS so the graph follows light/dark without a second palette. */
function tokens(el: HTMLElement) {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    root: v('--c-root'),
    affected: v('--c-affected'),
    risk: v('--c-risk'),
    healthy: v('--c-healthy'),
    edge: v('--c-edge'),
    text: v('--c-text'),
    surface: v('--c-surface'),
    accent: v('--c-accent'),
  };
}

function stylesheet(t: ReturnType<typeof tokens>): StylesheetJson {
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'font-size': 11,
        'font-family': 'system-ui, sans-serif',
        color: t.text,
        'text-valign': 'bottom',
        'text-margin-y': 6,
        'text-wrap': 'wrap',
        'text-max-width': '110px',
        'text-outline-color': t.surface,
        'text-outline-width': 2,
        'background-color': t.healthy,
        'border-width': 2,
        'border-color': t.healthy,
        width: 34,
        height: 34,
      },
    },
    { selector: 'node.healthy', style: { 'background-color': t.healthy, 'border-color': t.healthy, shape: 'ellipse' } },
    {
      selector: 'node.at_risk',
      style: { 'background-color': t.surface, 'border-color': t.risk, 'border-width': 3, 'border-style': 'dashed', shape: 'ellipse' },
    },
    {
      selector: 'node.affected',
      style: { 'background-color': t.affected, 'border-color': t.affected, shape: 'round-rectangle', width: 40, height: 40 },
    },
    {
      selector: 'node.root_cause',
      style: { 'background-color': t.root, 'border-color': t.root, shape: 'octagon', width: 50, height: 50, 'font-weight': 700 },
    },
    {
      selector: 'edge',
      style: {
        width: 'data(width)',
        'line-color': t.edge,
        'target-arrow-color': t.edge,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.8,
        'curve-style': 'bezier',
        opacity: 0.8,
        label: 'data(label)',
        'font-size': 9,
        color: t.text,
        'text-background-color': t.surface,
        'text-background-opacity': 0.85,
        'text-background-padding': '2px',
        'text-rotation': 'autorotate',
      },
    },
    { selector: 'edge.hot', style: { 'line-color': t.root, 'target-arrow-color': t.root, opacity: 0.95 } },
    { selector: '.dim', style: { opacity: 0.18 } },
    { selector: 'node.selected', style: { 'border-color': t.accent, 'border-width': 5 } },
  ] as StylesheetJson;
}

export function TopologyGraph({ topology, selectedNode, highlighted, onSelectNode }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const lastLayout = useRef<string>('');
  const onSelect = useRef(onSelectNode);
  onSelect.current = onSelectNode;

  const elements = useMemo(() => toElements(topology), [topology]);
  const structure = useMemo(() => layoutKey(topology), [topology]);

  // One Cytoscape instance for the component's lifetime.
  useEffect(() => {
    if (!container.current) return;
    const cy = cytoscape({
      container: container.current,
      style: stylesheet(tokens(container.current)),
      wheelSensitivity: 0.25,
      minZoom: 0.3,
      maxZoom: 2.5,
      boxSelectionEnabled: false,
    });
    cy.on('tap', 'node', (e) => onSelect.current(e.target.id()));
    cy.on('tap', (e) => {
      if (e.target === cy) onSelect.current(undefined);
    });
    cyRef.current = cy;

    // Light/dark switched while the page is open: restyle from the new token values.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const restyle = () => {
      if (container.current) cy.style(stylesheet(tokens(container.current)));
    };
    media.addEventListener('change', restyle);

    // The canvas was resized (window, rotation): keep the layout, rescale it to the new box.
    const observer = new ResizeObserver(() => {
      cy.resize();
      cy.fit(undefined, fitPadding(container.current));
    });
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', restyle);
      cy.destroy();
      cyRef.current = null;
      lastLayout.current = '';
    };
  }, []);

  // New data: re-lay-out only when the shape changed, otherwise update values in place.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    if (lastLayout.current !== structure) {
      cy.batch(() => {
        cy.elements().remove();
        cy.add(elements);
      });
      // A narrow canvas (phone) gets tighter columns and taller rows so labels stay readable
      // instead of the whole graph being scaled down to fit its widest row.
      const narrow = (container.current?.clientWidth ?? 1000) < 600;
      const positions = layeredPositions(topology, narrow ? { columnGap: 105, rowGap: 150 } : {});
      cy.layout({
        name: 'preset',
        positions,
        fit: true,
        padding: fitPadding(container.current),
        animate: false,
      }).run();
      lastLayout.current = structure;
    } else {
      cy.batch(() => {
        for (const el of elements) {
          const target = cy.getElementById(String(el.data.id));
          if (target.nonempty()) {
            target.data(el.data);
            target.classes(el.classes ?? '');
          }
        }
      });
    }
  }, [elements, structure, topology]);

  // Selection and incident focus are styling only: no re-layout.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().removeClass('dim').removeClass('selected');
      if (highlighted.size > 0) {
        cy.nodes().forEach((n) => {
          if (!highlighted.has(n.id())) n.addClass('dim');
        });
        cy.edges().forEach((e) => {
          if (!highlighted.has(e.source().id()) || !highlighted.has(e.target().id())) e.addClass('dim');
        });
      }
      if (selectedNode) cy.getElementById(selectedNode).addClass('selected');
    });
  }, [selectedNode, highlighted, elements]);

  const counts = STATUS_ORDER.map((s) => ({ s, n: topology.nodes.filter((x) => x.status === s).length }));
  return (
    <figure className="graph" aria-label="Service dependency graph">
      <div ref={container} className="graph-canvas" role="img" aria-label={`Dependency graph of ${topology.nodes.length} services and ${topology.edges.length} calls`} />
      <ul className="sr-only">
        {topology.nodes.map((n) => (
          <li key={n.id}>
            {n.id}: {STATUS[n.status].label}
          </li>
        ))}
      </ul>
      <figcaption className="legend">
        {counts.map(({ s, n }) => (
          <span key={s} className={`legend-item status-${s}`} title={STATUS[s].description}>
            <i className="legend-swatch" aria-hidden="true" />
            {STATUS[s].label} <b>{n}</b>
          </span>
        ))}
        <span className="legend-note">Edge width = call volume · label = lifetime average latency</span>
      </figcaption>
    </figure>
  );
}
