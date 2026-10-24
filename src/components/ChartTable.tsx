"use client";

interface ChartTableProps {
  caption: string;
  headers: string[];
  rows: string[][];
}

/** Text alternative for a chart: the same data as a plain table. */
export function ChartTable({ caption, headers, rows }: ChartTableProps) {
  return (
    <div className="zn-table-scroll zn-no-scrollbar">
      <table style={{ borderCollapse: "collapse", fontSize: 9, fontFamily: "var(--font-mono)" }}>
        <caption style={{ textAlign: "left", color: "var(--text-lo)", marginBottom: 4 }}>
          {caption}
        </caption>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} scope="col" style={{ padding: "0 8px 4px 0", textAlign: "right", color: "var(--text-lo)", fontWeight: 500 }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} style={{ padding: "2px 8px 2px 0", textAlign: "right", color: "var(--text-mid)" }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
