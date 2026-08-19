import express from "express";
import { pingCheck } from "../../controllers/pingController.js";
import authRouter from "./auth.js";
import projectRouter from "./projects.js";

const router = express.Router();

router.get("/ping", pingCheck);
router.use("/auth", authRouter);
router.use("/projects", projectRouter);

export default router;
