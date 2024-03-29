import {
  getStockUpdateTime,
  getActiveCount,
  getTotalCount,
  updateStock,
  scrapeWeb,
  TIME_CONFIG,
  insertWheelsIntoDatabase,
  insertStockIntoDatabase,
  createTables,
} from "./utils.js";
import {
  ACTIVATE_QUERY,
  CREATE_WHEEL_QUERY,
  DELETE_INACTIVE_WHEELS,
  GET_JOINED_ENTRY_BY_CODE,
  JOINED_TABLES_COUNT_QUERY,
  JOINED_TABLES_QUERY,
  NOTE_QUERY,
  UPDATE_QUERY,
} from "./queries.js";
import express from "express";
import sqlite3 from "sqlite3";
import cors from "cors";

const PORT = 3001;

// When developing locally this has to be changed to ../data...
// Due to current config in docker-compose
const db = new sqlite3.Database("data/wheels.db");

const app = express();

app.use(cors());

app.use(express.json());

app.put("/activate", async (req, res) => {
  const { isActive, code } = req.body;

  db.run(ACTIVATE_QUERY, [code, isActive], (err) => {
    if (err) {
      console.error(err.message);
      res.status(500).json({ error: err.message });
    }
  });

  const { activeTotal, suspendedTotal } = await getActiveCount(db);

  db.each(GET_JOINED_ENTRY_BY_CODE, [code], (err, row) => {
    if (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    } else {
      res.json({ activeTotal, suspendedTotal, wheel: row });
    }
  });
});

app.delete("/activate", async (req, res) => {
  const code = decodeURIComponent(req.query.code);
  db.run("DELETE FROM active WHERE code = ?", [code], (err) => {
    if (err) {
      console.error(err);
      res.status(500).json(err);
    }
  });
  const { activeTotal, suspendedTotal } = await getActiveCount(db);
  res.status(200).json({ code, activeTotal, suspendedTotal });
});

app.put("/notes", async (req, res) => {
  const { code, notes } = req.body;

  db.run(NOTE_QUERY, [code, notes], (err) => {
    if (err) {
      console.error(err.message);
      res.status(500).json({ error: err.message });
    }
  });

  db.each(GET_JOINED_ENTRY_BY_CODE, [code], (err, row) => {
    if (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    } else {
      res.json(row);
    }
  });
});

app.get("/search", (req, res) => {
  const { page, pageSize, designCode, colorCode, size, holes, pcd, isActive } =
    req.query;

  const OFFSET = (page - 1) * pageSize;

  let paramsQuery = " WHERE 1";

  if (designCode) paramsQuery += ` AND designCode LIKE '%${designCode}%'`;
  if (colorCode) paramsQuery += ` AND colorCode LIKE '%${colorCode}%'`;
  if (size) paramsQuery += ` AND size = "${size}"`;
  if (holes) paramsQuery += ` AND holes = "${holes}"`;
  if (pcd) paramsQuery += ` AND pcd LIKE '%${pcd}%'`;
  if (isActive) paramsQuery += ` AND isActive = "${isActive}"`;

  const countQuery = JOINED_TABLES_COUNT_QUERY + paramsQuery;

  const searchQuery =
    JOINED_TABLES_QUERY +
    paramsQuery +
    ` ORDER BY modifier IS NULL DESC LIMIT ${pageSize} OFFSET ${OFFSET}`;

  db.get(countQuery, async (err, countRow) => {
    if (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }

    const { total = 0 } = countRow;

    db.all(searchQuery, (err, rows) => {
      if (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
      }
      res.json({ paginatedData: rows, total });
    });
  });
});

app.get("/update_database", async (_req, res) => {
  try {
    console.log("Scraping");
    const { wheelBase, stock } = await scrapeWeb("all");

    console.log("Updating Wheels");
    await new Promise((resolve, reject) => {
      db.run(DELETE_INACTIVE_WHEELS, async (err) => {
        if (err) {
          console.error("Error:", err);
          reject(err);
        } else {
          await insertWheelsIntoDatabase(db, wheelBase);
          resolve();
        }
      });
    });

    const time = new Date().toLocaleString("default", TIME_CONFIG);

    console.log("Updating Inventory");
    await new Promise((resolve, reject) => {
      db.run("DELETE FROM stock", async (err) => {
        if (err) {
          console.error(err);
          reject(err);
        } else {
          await new Promise((resolveSerialize) => {
            db.serialize(async () => {
              for (const entry of stock) {
                await updateStock(db, entry.code, entry.amount, time);
              }
              resolveSerialize();
            });
          });
          resolve();
        }
      });
    });

    const { total } = await getTotalCount(db);
    res.json({ time, total });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/update", async (req, res) => {
  try {
    const { code, designCode, colorCode, size, width, holes, pcd, et, cb } =
      req.body;

    db.run(
      UPDATE_QUERY,
      [designCode, colorCode, size, width, holes, pcd, et, cb, code],
      (err) => {
        if (err) {
          console.error(err);
          res.status(500).json({ error: err.message });
        }
      }
    );

    db.each(GET_JOINED_ENTRY_BY_CODE, [code], (err, row) => {
      if (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
      } else {
        res.json(row);
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/metadata", async (_req, res) => {
  try {
    const { updatedTime = "" } = await getStockUpdateTime(db);
    const { total } = await getTotalCount(db);
    const { activeTotal, suspendedTotal } = await getActiveCount(db);
    res.json({
      updatedTime,
      total,
      activeTotal,
      suspendedTotal,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/", async (req, res) => {
  try {
    const {
      description,
      code,
      designCode,
      colorCode,
      size,
      width,
      holes,
      pcd,
      et,
      cb,
    } = req.body;

    db.run(
      CREATE_WHEEL_QUERY,
      [
        description,
        code,
        designCode,
        colorCode,
        size,
        width,
        holes,
        pcd,
        et,
        cb,
      ],
      (err) => {
        if (err) {
          console.error(err);
          res.status(500).json({ error: err.message });
        } else {
          db.each(GET_JOINED_ENTRY_BY_CODE, [code], (err, row) => {
            if (err) {
              console.error(err);
              res.status(500).json({ error: err.message });
            } else {
              res.json(row);
            }
          });
        }
      }
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/", async (req, res) => {
  const code = decodeURIComponent(req.query.code);
  db.run("DELETE FROM wheels WHERE code = ?", [code], (err) => {
    if (err) {
      console.error(err);
      res.status(500).json(err);
    }
  });
  const { activeTotal, suspendedTotal } = await getActiveCount(db);
  res.status(200).json({ code, activeTotal, suspendedTotal });
});

app.get("/init", async (_req, res) => {
  try {
    console.log("creating tables");
    await createTables(db);

    console.log("scraping");
    const { wheelBase, stock } = await scrapeWeb("all");

    console.log("inserting");
    await insertWheelsIntoDatabase(db, wheelBase);
    await insertStockIntoDatabase(db, stock);
    res.status(200).json({});
  } catch (err) {
    console.error(err);
    res.status(500).json(err);
  }
});

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
