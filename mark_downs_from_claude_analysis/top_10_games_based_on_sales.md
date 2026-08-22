<!-- Add this to chatGPT or cluade - copy/past and add the prompt "Can you provide the visualization and analysis report from this markdown so I can show to the stakeholders" -->

# Kaggle Dataset Analyst — vgsales.csv
_8/22/2026, 4:34:05 PM_

**Question:** Top 10 video games based on sales

## Tool calls

### `profile_dataset(filename="vgsales.csv", sample_rows=15)`

**Summary**

| Metric | Value | Note |
| --- | --- | --- |
| Rows | 16,598 |  |
| Columns | 11 |  |
| Columns with gaps | 2 |  |

**View schema as table**

| Column | Dtype | Missing |
| --- | --- | --- |
| Rank | int64 | 0 |
| Name | str | 0 |
| Platform | str | 0 |
| Year | float64 | 271 |
| Genre | str | 0 |
| Publisher | str | 58 |
| NA_Sales | float64 | 0 |
| EU_Sales | float64 | 0 |
| JP_Sales | float64 | 0 |
| Other_Sales | float64 | 0 |
| Global_Sales | float64 | 0 |

### `detect_missing_values(filename="vgsales.csv")`

**View as table**

| Column | Missing | % of rows |
| --- | --- | --- |
| Year | 271 | 1.63 |
| Publisher | 58 | 0.35 |

### `plot_distribution(filename="vgsales.csv", column="Global_Sales", bins=50)`

```json
{
  "message": "Saved distribution plot to C:\\dev\\kaggle_mcp_project\\kaggle_mcp\\outputs\\vgsales_Global_Sales_dist.png"
}
```

## Findings

I'll start by profiling the dataset to see the real columns before ranking anything.

**Wii Sports is the best-selling title at 82.74M units — more than double the #2 game, and every one of the top 10 is published by Nintendo.**

The file is already sorted by `Rank`, which maps exactly to `Global_Sales` descending, so ranks 1–10 are the answer directly.

## The top 10 by global sales

| Rank | Name | Platform | Year | Genre | Global (M) |
|---|---|---|---|---|---|
| 1 | Wii Sports | Wii | 2006 | Sports | 82.74 |
| 2 | Super Mario Bros. | NES | 1985 | Platform | 40.24 |
| 3 | Mario Kart Wii | Wii | 2008 | Racing | 35.82 |
| 4 | Wii Sports Resort | Wii | 2009 | Sports | 33.00 |
| 5 | Pokemon Red/Pokemon Blue | GB | 1996 | Role-Playing | 31.37 |
| 6 | Tetris | GB | 1989 | Puzzle | 30.26 |
| 7 | New Super Mario Bros. | DS | 2006 | Platform | 30.01 |
| 8 | Wii Play | Wii | 2006 | Misc | 29.02 |
| 9 | New Super Mario Bros. Wii | Wii | 2009 | Platform | 28.62 |
| 10 | Duck Hunt | NES | 1984 | Shooter | 28.31 |

```chart
{"chart":"bar","title":"Top 10 games by global sales","insight":"Wii Sports (82.74M) is a 42.5M-unit outlier; ranks 2-10 cluster tightly between 28.31M and 40.24M.","unit":"million units","series":[{"name":"Global sales","points":[{"x":"Wii Sports","y":82.74},{"x":"Super Mario Bros.","y":40.24},{"x":"Mario Kart Wii","y":35.82},{"x":"Wii Sports Resort","y":33.0},{"x":"Pokemon Red/Blue","y":31.37},{"x":"Tetris","y":30.26},{"x":"New Super Mario Bros.","y":30.01},{"x":"Wii Play","y":29.02},{"x":"New Super Mario Bros. Wii","y":28.62},{"x":"Duck Hunt","y":28.31}]}]}
```

## Rank 1 is in a class of its own

After Wii Sports the curve flattens hard: the gap from #1 to #2 is 42.50M, while the entire spread from #2 to #10 is only 11.93M. Five of the ten are Wii titles (82.74 + 35.82 + 33.00 + 29.02 + 28.62 = 209.20M, 60% of the top-10 total of 348.39M).

```chart
{"chart":"donut","title":"Top-10 sales by platform","insight":"The Wii alone accounts for 209.20M of the 348.39M units in the top 10.","unit":"million units","series":[{"name":"Global sales","points":[{"x":"Wii","y":209.2},{"x":"NES","y":68.55},{"x":"GB","y":61.63},{"x":"DS","y":30.01}]}]}
```

## Where those sales came from

Regional mix separates the list into two kinds of hit. Duck Hunt is almost purely North American (26.93 of 28.31M = 95%), while Pokemon Red/Blue is the most Japan-weighted (10.22M JP — also the maximum JP_Sales value in the whole dataset).

```chart
{"chart":"column","title":"Regional split of the top 5","insight":"Wii Sports leads in both NA (41.49M) and EU (29.02M); Pokemon Red/Blue is the only top-5 title where Japan rivals the West.","unit":"million units","series":[{"name":"NA","points":[{"x":"Wii Sports","y":41.49},{"x":"Super Mario Bros.","y":29.08},{"x":"Mario Kart Wii","y":15.85},{"x":"Wii Sports Resort","y":15.75},{"x":"Pokemon Red/Blue","y":11.27}]},{"name":"EU","points":[{"x":"Wii Sports","y":29.02},{"x":"Super Mario Bros.","y":3.58},{"x":"Mario Kart Wii","y":12.88},{"x":"Wii Sports Resort","y":11.01},{"x":"Pokemon Red/Blue","y":8.89}]},{"name":"JP","points":[{"x":"Wii Sports","y":3.77},{"x":"Super Mario Bros.","y":6.81},{"x":"Mario Kart Wii","y":3.79},{"x":"Wii Sports Resort","y":3.28},{"x":"Pokemon Red/Blue","y":10.22}]},{"name":"Other","points":[{"x":"Wii Sports","y":8.46},{"x":"Super Mario Bros.","y":0.77},{"x":"Mario Kart Wii","y":3.31},{"x":"Wii Sports Resort","y":2.96},{"x":"Pokemon Red/Blue","y":1.0}]}]}
```

## How extreme this really is

The histogram above shows why the top 10 barely register as a visible bar: across all 16,598 titles the median game sold **0.17M** and the 75th percentile is **0.47M**, against a mean of 0.54M. Wii Sports at 82.74M sits roughly 53 standard deviations (std = 1.56) above that mean.

Data quality is not a factor here — the sales columns have zero missing values; the only gaps are `Year` (271 rows, 1.63%) and `Publisher` (58 rows, 0.35%), none of which affect the top 10.

**Caveat worth flagging:** `Name` has 11,493 unique values across 16,598 rows, so multi-platform games are split into separate rows. This ranking is per game-platform release, not per franchise title. Next step I'd take: aggregate `Global_Sales` by `Name` to see whether a cross-platform title like Grand Theft Auto V or Call of Duty breaks into the top 10 once its platform releases are summed.
